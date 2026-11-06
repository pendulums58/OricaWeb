/* CyanPro 듀얼 통계 수집기 (Cloudflare Worker + D1)
 *
 * POST /duels        CyanPro 호스트가 듀얼 결과를 보낸다
 * GET  /stats/cards  카드별 채용률·승률, 사용 시 / 미사용 시 승률
 * GET  /stats/summary 전체 요약
 * GET  /admin/duels  최근 기록 (관리자 토큰 필요)
 * POST /admin/hide   잘못된 기록 숨기기 (관리자 토큰 필요)
 * GET  /update       CyanPro 클라이언트 자동 업데이트 목록
 */

const MAX_BODY = 64 * 1024;
const ZONES = ["main", "extra", "side"];

const json = (data, status = 200, origin = "*") =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin,
      "cache-control": "no-store",
    },
  });

const corsHeaders = origin => ({
  "access-control-allow-origin": origin,
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
  "access-control-max-age": "86400",
});

/* ---------- 들어온 보고가 말이 되는지 ---------- */
function validate(body) {
  const fail = m => ({ ok: false, why: m });

  if (!body || typeof body !== "object") return fail("본문이 객체가 아니다");
  const id = String(body.duel_id || "").trim();
  if (!/^[0-9a-f]{16,64}$/i.test(id)) return fail("duel_id 형식이 아니다");

  // 0 / 1 은 승자, 2 는 무승부
  const winner = Number(body.winner);
  if (![0, 1, 2].includes(winner)) return fail("winner 는 0, 1, 2 중 하나여야 한다");

  if (!Array.isArray(body.players) || body.players.length !== 2)
    return fail("players 는 2명이어야 한다");

  for (const p of body.players) {
    const seat = Number(p.seat);
    if (seat !== 0 && seat !== 1) return fail("seat 는 0 또는 1 이어야 한다");
    const deck = p.deck || {};
    for (const z of ZONES) {
      const list = deck[z];
      if (list === undefined) continue;
      if (!Array.isArray(list)) return fail(`${z} 가 배열이 아니다`);
      for (const c of list) {
        if (!Number.isInteger(c) || c <= 0 || c > 0xFFFFFFFF)
          return fail("카드 ID 가 올바르지 않다");
      }
    }
    const main = (deck.main || []).length;
    const extra = (deck.extra || []).length;
    const side = (deck.side || []).length;
    if (main < 40 || main > 60) return fail(`메인 덱이 ${main}장이다`);
    if (extra > 15) return fail(`엑스트라 덱이 ${extra}장이다`);
    if (side > 15) return fail(`사이드 덱이 ${side}장이다`);
  }
  if (body.players[0].seat === body.players[1].seat) return fail("seat 가 겹친다");

  const source = body.source === "sim" ? "sim" : "human";

  for (const p of body.players) {
    if (p.player_no !== undefined &&
        (!Number.isInteger(p.player_no) || p.player_no < 0 || p.player_no > 7))
      return fail("player_no 가 올바르지 않다");
    // 이 판에 한 번이라도 발동 / 소환한 카드, 개시 때 덱에서 패로 가져온 카드.
    // 호스트가 가공 없이 보낸다
    for (const k of ["activated", "summoned", "fetched"]) {
      const list = p[k];
      if (list === undefined) continue;
      if (!Array.isArray(list)) return fail(`${k} 가 배열이 아니다`);
      if (list.length > 300) return fail(`${k} 항목이 너무 많다`);
      for (const c of list)
        if (!Number.isInteger(c) || c <= 0 || c > 0xFFFFFFFF)
          return fail(`${k} 의 카드 ID 가 올바르지 않다`);
    }
    if (p.usage === undefined) continue;
    if (!Array.isArray(p.usage)) return fail("usage 가 배열이 아니다");
    if (p.usage.length > 400) return fail("usage 항목이 너무 많다");
    for (const u of p.usage) {
      if (!u || !Number.isInteger(u.card_id) || u.card_id <= 0)
        return fail("usage 의 card_id 가 올바르지 않다");
      for (const k of ["offered", "taken"]) {
        const v = u[k];
        if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 10000))
          return fail(`usage 의 ${k} 가 올바르지 않다`);
      }
    }
  }
  // 양쪽 다 사용 기록을 보냈을 때만 이 판을 사용 통계에 넣는다.
  // 패치 전 호스트가 보낸 판을 "아무것도 안 쓴 판" 으로 세면 미사용 승률이 망가진다.
  const hasPlay = body.players.every(p =>
    Array.isArray(p.activated) && Array.isArray(p.summoned));
  // fetched 는 1.0.8 다음 빌드부터 온다. 1.0.8 판도 사용 통계에는 넣되,
  // 그 판들은 가져옴을 모른다는 표시를 따로 남긴다.
  const hasFetch = hasPlay && body.players.every(p => Array.isArray(p.fetched));
  return { ok: true, id, winner, source, hasPlay, hasFetch };
}

/* 메인 + 엑스트라 구성의 지문. 같은 레시피면 같은 값이 나온다.
 * 사이드는 넣지 않는다 — 호스트가 보내는 덱은 사이드 교체가 끝난 상태라
 * 매치의 2·3차전이 1차전과 다른 리스트로 들어오기 때문이다. */
async function deckHash(deck) {
  const parts = [];
  for (const zone of ["main", "extra"]) {
    for (const [id, qty] of [...tally((deck || {})[zone])].sort((a, b) => a[0] - b[0]))
      parts.push(`${zone[0]}${id}x${qty}`);
  }
  const bytes = new TextEncoder().encode(parts.join(","));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].slice(0, 12)
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

function tally(list) {
  const m = new Map();
  for (const c of list || []) m.set(c, (m.get(c) || 0) + 1);
  return m;
}

/* 이 판에 쓴 카드 중 그 사람 메인 + 엑스트라에 있던 것만 남긴다.
 * 토큰, 상대에게서 뺏었지만 내 덱엔 없는 카드는 여기서 빠진다.
 * 양쪽 덱에 다 있는 카드를 뺏어 썼다면 쓴 사람 몫으로 센다 —
 * 자기 덱에서 꺼내 쓴 것과 다르지 않다. */
function playedRows(p) {
  const deck = p.deck || {};
  const inDeck = new Set([...(deck.main || []), ...(deck.extra || [])]);
  const act = new Set((p.activated || []).filter(c => inDeck.has(c)));
  const sum = new Set((p.summoned || []).filter(c => inDeck.has(c)));
  // 개시 때 덱에서 패로 온 카드. 단짝 지정으로 +1 을 얻은 경우가 이것이다.
  // 이미 손에 있던 단짝을 지정한 판은 이득이 없으므로 호스트가 애초에 보내지 않는다.
  const fet = new Set((p.fetched || []).filter(c => inDeck.has(c)));
  return [...new Set([...act, ...sum, ...fet])].sort((a, b) => a - b).map(card_id => ({
    card_id,
    activated: act.has(card_id) ? 1 : 0,
    summoned: sum.has(card_id) ? 1 : 0,
    fetched: fet.has(card_id) ? 1 : 0,
  }));
}

/* ---------- 수집 ---------- */
async function ingest(request, env, origin) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: "본문이 너무 크다" }, 413, origin);

  let body;
  try { body = JSON.parse(raw); }
  catch { return json({ error: "JSON 을 읽지 못했다" }, 400, origin); }

  const check = validate(body);
  if (!check.ok) return json({ error: check.why }, 400, origin);

  const now = Math.floor(Date.now() / 1000);
  const ended = Number.isFinite(Number(body.ended_at)) ? Number(body.ended_at) : now;

  // 같은 duel_id 가 이미 있으면 아무것도 하지 않는다 (재전송·양쪽 보고 대비)
  const existing = await env.DB.prepare(
    "SELECT duel_id FROM duels WHERE duel_id = ?").bind(check.id).first();
  if (existing) return json({ ok: true, duplicate: true }, 200, origin);

  const stmts = [
    env.DB.prepare(
      `INSERT INTO duels (duel_id, match_id, game_no, format, winner, ended_at,
                          version, reporter, received_at, source, has_play, has_fetch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      check.id,
      body.match_id ? String(body.match_id).slice(0, 64) : null,
      Number.isFinite(Number(body.game_no)) ? Number(body.game_no) : null,
      body.format ? String(body.format).slice(0, 80) : null,
      check.winner,
      ended,
      body.version ? String(body.version).slice(0, 40) : null,
      body.reporter ? String(body.reporter).slice(0, 64) : null,
      now,
      check.source,
      check.hasPlay ? 1 : 0,
      check.hasFetch ? 1 : 0),
  ];

  for (const p of body.players) {
    const seat = Number(p.seat);
    stmts.push(env.DB.prepare(
      `INSERT INTO duel_players (duel_id, seat, name, won, deck_hash, player_no)
       VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(check.id, seat, p.name ? String(p.name).slice(0, 60) : null,
            seat === check.winner ? 1 : 0, await deckHash(p.deck),
            Number.isInteger(p.player_no) ? p.player_no : null));   // 무승부(2)면 양쪽 다 0

    for (const u of (p.usage || [])) {
      stmts.push(env.DB.prepare(
        "INSERT INTO card_usage (duel_id, seat, card_id, offered, taken) VALUES (?, ?, ?, ?, ?)")
        .bind(check.id, seat, u.card_id, u.offered || 0, u.taken || 0));
    }

    for (const zone of ZONES) {
      for (const [cardId, qty] of tally((p.deck || {})[zone])) {
        stmts.push(env.DB.prepare(
          "INSERT INTO deck_cards (duel_id, seat, zone, card_id, qty) VALUES (?, ?, ?, ?, ?)")
          .bind(check.id, seat, zone, cardId, qty));
      }
    }

    if (check.hasPlay) {
      for (const row of playedRows(p)) {
        stmts.push(env.DB.prepare(
          "INSERT INTO card_played (duel_id, seat, card_id, activated, summoned, fetched) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(check.id, seat, row.card_id, row.activated, row.summoned, row.fetched));
      }
    }
  }

  await env.DB.batch(stmts);
  return json({ ok: true, duel_id: check.id }, 201, origin);
}

/* ---------- 카드별 통계 ---------- */
async function cardStats(env, origin, url) {
  // zone=main (기본, 메인+엑스트라) | all (사이드 포함) | side (사이드만)
  const zoneWanted = url.searchParams.get("zone");
  const zoneFilter = zoneWanted === "all" ? ZONES
                   : zoneWanted === "side" ? ["side"]
                   : ["main", "extra"];
  const placeholders = zoneFilter.map(() => "?").join(",");

  // source=human | sim | all (기본 human — 시뮬레이션이 사람 통계를 덮지 않게)
  const want = url.searchParams.get("source") || "human";
  const sourceSql = want === "all" ? "" : " AND d.source = ?";
  const sourceArg = want === "all" ? [] : [want === "sim" ? "sim" : "human"];

  const rows = await env.DB.prepare(
    `SELECT dc.card_id            AS card_id,
            COUNT(*)                        AS decks,
            SUM(dp.won)                     AS wins,
            SUM(CASE WHEN d.winner = 2 THEN 0 ELSE 1 END) AS decided,
            SUM(dc.qty)                     AS copies
       FROM (SELECT duel_id, seat, card_id, SUM(qty) AS qty
               FROM deck_cards
              WHERE zone IN (${placeholders})
              GROUP BY duel_id, seat, card_id) dc
       JOIN duel_players dp ON dp.duel_id = dc.duel_id AND dp.seat = dc.seat
       JOIN duels d         ON d.duel_id  = dc.duel_id
      WHERE d.hidden = 0${sourceSql}
      GROUP BY dc.card_id`).bind(...zoneFilter, ...sourceArg).all();

  const usage = await env.DB.prepare(
    `SELECT u.card_id, SUM(u.offered) AS offered, SUM(u.taken) AS taken
       FROM card_usage u
       JOIN duels d ON d.duel_id = u.duel_id
      WHERE d.hidden = 0${sourceSql}
      GROUP BY u.card_id`).bind(...sourceArg).all();
  const usageById = new Map((usage.results || []).map(r => [r.card_id, r]));

  // 사용 통계: 덱에 있던 판을 "썼다 / 안 썼다" 로 나눠 각각의 승패를 센다.
  // 썼다 = 발동 · 소환 · 개시 때 덱에서 패로 가져옴 중 하나라도 (card_played 에 행이 있다).
  // 한 판에 여러 번 써도 1 이다. 사용 기록을 보낸 판(has_play)만 본다.
  // 사이드에 있던 카드는 그 판에 쓸 수 없으므로 zone 과 상관없이 메인 + 엑스트라만 본다.
  const played = await env.DB.prepare(
    `SELECT dc.card_id AS card_id,
            COUNT(*) AS games,
            SUM(CASE WHEN cp.card_id IS NOT NULL THEN 1 ELSE 0 END) AS used,
            SUM(CASE WHEN cp.card_id IS NOT NULL THEN dp.won ELSE 0 END) AS used_wins,
            SUM(CASE WHEN cp.card_id IS NOT NULL AND d.winner <> 2 THEN 1 ELSE 0 END) AS used_decided,
            SUM(CASE WHEN cp.card_id IS NULL THEN dp.won ELSE 0 END) AS unused_wins,
            SUM(CASE WHEN cp.card_id IS NULL AND d.winner <> 2 THEN 1 ELSE 0 END) AS unused_decided,
            SUM(COALESCE(cp.activated, 0)) AS activated,
            SUM(COALESCE(cp.summoned, 0))  AS summoned,
            SUM(COALESCE(cp.fetched, 0))   AS fetched
       FROM (SELECT DISTINCT duel_id, seat, card_id FROM deck_cards
              WHERE zone IN ('main', 'extra')) dc
       JOIN duel_players dp ON dp.duel_id = dc.duel_id AND dp.seat = dc.seat
       JOIN duels d         ON d.duel_id  = dc.duel_id
       LEFT JOIN card_played cp
              ON cp.duel_id = dc.duel_id AND cp.seat = dc.seat AND cp.card_id = dc.card_id
      WHERE d.hidden = 0 AND d.has_play = 1${sourceSql}
      GROUP BY dc.card_id`).bind(...sourceArg).all();
  const playedById = new Map((played.results || []).map(r => [r.card_id, r]));

  const playTotals = await env.DB.prepare(
    `SELECT COUNT(*) AS duels, SUM(d.has_fetch) AS fetch_duels FROM duels d
      WHERE d.hidden = 0 AND d.has_play = 1${sourceSql}`).bind(...sourceArg).first();

  // 고유 덱은 game_no = 1 인 판만 센다 (사이드 교체 전 원본 리스트)
  const firstGame = " AND (d.game_no IS NULL OR d.game_no <= 1)";

  const uniqueRows = await env.DB.prepare(
    `SELECT dc.card_id AS card_id, COUNT(DISTINCT dp.deck_hash) AS n
       FROM (SELECT DISTINCT duel_id, seat, card_id FROM deck_cards
              WHERE zone IN (${placeholders})) dc
       JOIN duel_players dp ON dp.duel_id = dc.duel_id AND dp.seat = dc.seat
       JOIN duels d         ON d.duel_id  = dc.duel_id
      WHERE d.hidden = 0 AND dp.deck_hash IS NOT NULL${sourceSql}${firstGame}
      GROUP BY dc.card_id`).bind(...zoneFilter, ...sourceArg).all();
  const uniqueById = new Map((uniqueRows.results || []).map(r => [r.card_id, r.n]));

  const uniqueTotal = await env.DB.prepare(
    `SELECT COUNT(DISTINCT dp.deck_hash) AS n
       FROM duel_players dp
       JOIN duels d ON d.duel_id = dp.duel_id
      WHERE d.hidden = 0 AND dp.deck_hash IS NOT NULL${sourceSql}${firstGame}`)
    .bind(...sourceArg).first();

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS decks,
            COUNT(DISTINCT dp.duel_id) AS duels
       FROM duel_players dp
       JOIN duels d ON d.duel_id = dp.duel_id
      WHERE d.hidden = 0${sourceSql}`).bind(...sourceArg).first();

  return json({
    source: want,
    zone: zoneWanted === "all" ? "all" : zoneWanted === "side" ? "side" : "main",
    total_decks: totals ? totals.decks : 0,
    total_duels: totals ? totals.duels : 0,
    unique_decks: uniqueTotal ? uniqueTotal.n : 0,
    play_duels: playTotals ? playTotals.duels : 0,
    // 그중 개시 가져옴까지 기록된 판. 나머지 판에서는 가져오기만 한 단짝이 미사용으로 잡힌다
    fetch_duels: playTotals ? (playTotals.fetch_duels || 0) : 0,
    cards: (rows.results || []).map(r => {
      const u = usageById.get(r.card_id);
      const pl = playedById.get(r.card_id);
      return {
        id: r.card_id,
        decks: r.decks,
        unique: uniqueById.get(r.card_id) || 0,
        wins: r.wins,
        decided: r.decided,
        copies: r.copies,
        offered: u ? u.offered : 0,
        taken: u ? u.taken : 0,
        // 사용 통계 — 사용 기록이 있는 판만 센 값이라 decks 와 분모가 다르다
        play: pl ? {
          games: pl.games,
          used: pl.used,
          used_wins: pl.used_wins,
          used_decided: pl.used_decided,
          unused_wins: pl.unused_wins,
          unused_decided: pl.unused_decided,
          activated: pl.activated,
          summoned: pl.summoned,
          fetched: pl.fetched,
        } : null,
      };
    }),
  }, 200, origin);
}

/* ---------- 덱 레시피별 통계 ----------
 *
 * 매치의 1차전 덱을 그 매치의 정식 레시피로 보고, 2·3차전 결과까지 거기에 귀속시킨다.
 * 사이드 교체 때문에 2·3차전은 리스트가 달라 보이지만 같은 덱이다.
 *
 * 사람을 묶는 기준은 seat 이 아니라 player_no 다. 진 쪽이 선공을 고르면
 * 자리가 매치 중간에 뒤집힌다.
 *
 * 집계는 SQL 로 짜기 까다로워 행을 받아 와 여기서 묶는다. 이 규모에서는 충분하다.
 */
function groupDecks(rows) {
  // 1) 매치별·사람별 정식 레시피 = 가장 이른 판의 덱 지문
  const canon = new Map();            // "mid\u0000player" -> {hash, duel_id, gno}
  for (const r of rows) {
    if (r.player_no === null || r.player_no === undefined || !r.deck_hash) continue;
    const mid = r.match_id || r.duel_id;
    const key = mid + "\u0000" + r.player_no;
    const gno = r.game_no == null ? 1 : r.game_no;
    const cur = canon.get(key);
    if (!cur || gno < cur.gno)
      canon.set(key, { hash: r.deck_hash, duel_id: r.duel_id, seat: r.seat, gno });
  }

  // 2) 레시피별로 듀얼과 매치를 모은다
  const decks = new Map();            // hash -> 집계
  const perMatch = new Map();         // "mid\u0000player" -> {hash, wins, games}
  for (const r of rows) {
    if (r.player_no === null || r.player_no === undefined) continue;
    const mid = r.match_id || r.duel_id;
    const key = mid + "\u0000" + r.player_no;
    const c = canon.get(key);
    if (!c) continue;

    let d = decks.get(c.hash);
    if (!d) {
      d = { hash: c.hash, duels: 0, duel_wins: 0, matches: 0, match_wins: 0,
            sample_duel: c.duel_id, sample_seat: c.seat, names: new Set() };
      decks.set(c.hash, d);
    }
    d.duels++;
    d.duel_wins += r.won;
    if (r.name) d.names.add(r.name);

    let m = perMatch.get(key);
    if (!m) { m = { hash: c.hash, mid, wins: 0, games: 0 }; perMatch.set(key, m); }
    m.wins += r.won;
    m.games++;
  }

  // 3) 매치 승패 — 같은 매치 안에서 듀얼을 더 많이 이긴 쪽이 이긴 것
  const byMatch = new Map();          // mid -> [entry...]
  for (const m of perMatch.values()) {
    if (!byMatch.has(m.mid)) byMatch.set(m.mid, []);
    byMatch.get(m.mid).push(m);
  }
  for (const side of byMatch.values()) {
    const best = Math.max(...side.map(x => x.wins));
    const tied = side.filter(x => x.wins === best).length > 1;
    for (const m of side) {
      const d = decks.get(m.hash);
      if (!d) continue;
      d.matches++;
      if (!tied && m.wins === best && best > 0) d.match_wins++;
    }
  }

  return [...decks.values()].map(d => ({
    hash: d.hash,
    duels: d.duels,
    duel_wins: d.duel_wins,
    matches: d.matches,
    match_wins: d.match_wins,
    pilots: d.names.size,
    sample_duel: d.sample_duel,
    sample_seat: d.sample_seat,
  })).sort((a, b) => b.matches - a.matches || b.duels - a.duels);
}

async function deckStats(env, origin, url) {
  const want = url.searchParams.get("source") || "human";
  const sourceSql = want === "all" ? "" : " AND d.source = ?";
  const sourceArg = want === "all" ? [] : [want === "sim" ? "sim" : "human"];

  const rows = await env.DB.prepare(
    `SELECT dp.duel_id, dp.seat, dp.name, dp.won, dp.deck_hash, dp.player_no,
            d.match_id, d.game_no
       FROM duel_players dp
       JOIN duels d ON d.duel_id = dp.duel_id
      WHERE d.hidden = 0${sourceSql}
      ORDER BY d.received_at
      LIMIT 20000`).bind(...sourceArg).all();

  const decks = groupDecks(rows.results || []).slice(0, 200);

  // 각 레시피의 카드 목록 — 정식 레시피가 된 그 판의 덱
  const wanted = decks.map(d => d.sample_duel);
  const cardsByKey = new Map();
  if (wanted.length) {
    const marks = wanted.map(() => "?").join(",");
    const cards = await env.DB.prepare(
      `SELECT duel_id, seat, zone, card_id, qty FROM deck_cards
        WHERE duel_id IN (${marks})`).bind(...wanted).all();
    for (const c of cards.results || []) {
      const k = c.duel_id + "\u0000" + c.seat;
      if (!cardsByKey.has(k)) cardsByKey.set(k, { main: [], extra: [], side: [] });
      const zone = cardsByKey.get(k)[c.zone];
      if (zone) zone.push({ id: c.card_id, qty: c.qty });
    }
  }
  for (const d of decks) {
    d.deck = cardsByKey.get(d.sample_duel + "\u0000" + d.sample_seat)
          || { main: [], extra: [], side: [] };
    delete d.sample_seat;
  }

  return json({ source: want, decks }, 200, origin);
}

async function summary(env, origin) {
  const d = await env.DB.prepare(
    `SELECT COUNT(*) AS duels,
            MIN(ended_at) AS first_at,
            MAX(ended_at) AS last_at
       FROM duels WHERE hidden = 0`).first();
  const hidden = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM duels WHERE hidden = 1").first();
  const bySource = await env.DB.prepare(
    `SELECT source, COUNT(*) AS n FROM duels WHERE hidden = 0 GROUP BY source`).all();
  const formats = await env.DB.prepare(
    `SELECT format, COUNT(*) AS n FROM duels WHERE hidden = 0
      GROUP BY format ORDER BY n DESC LIMIT 20`).all();
  return json({
    duels: d ? d.duels : 0,
    first_at: d ? d.first_at : null,
    last_at: d ? d.last_at : null,
    hidden: hidden ? hidden.n : 0,
    by_source: bySource.results || [],
    formats: formats.results || [],
  }, 200, origin);
}

/* ---------- 관리자 ---------- */
const adminOk = (request, env) => {
  const token = (env.ADMIN_TOKEN || "").trim();
  if (!token) return false;
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (given.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
};

async function adminDuels(request, env, origin, url) {
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
  const rows = await env.DB.prepare(
    `SELECT d.duel_id, d.match_id, d.game_no, d.format, d.winner, d.ended_at,
            d.version, d.reporter, d.hidden, d.note,
            (SELECT GROUP_CONCAT(name, ' vs ') FROM duel_players p
              WHERE p.duel_id = d.duel_id ORDER BY p.seat) AS players,
            (SELECT COUNT(*) FROM deck_cards c WHERE c.duel_id = d.duel_id) AS card_rows
       FROM duels d
      ORDER BY d.received_at DESC
      LIMIT ?`).bind(limit).all();
  return json({ duels: rows.results || [] }, 200, origin);
}

async function adminHide(request, env, origin) {
  const body = await request.json().catch(() => null);
  if (!body || !body.duel_id) return json({ error: "duel_id 가 없다" }, 400, origin);
  const hidden = body.hidden === false ? 0 : 1;
  await env.DB.prepare(
    "UPDATE duels SET hidden = ?, note = ? WHERE duel_id = ?")
    .bind(hidden, body.note ? String(body.note).slice(0, 200) : null,
          String(body.duel_id)).run();
  return json({ ok: true, hidden }, 200, origin);
}

/* ---------- 클라이언트 자동 업데이트 ----------
 * CyanPro 의 client_updater 가 시작할 때 GET 한다. User-Agent 가
 * "CyanPro-Windows-1.0.3 ..." 꼴이라 여기서 버전을 읽는다.
 * 응답은 [{ name, url, md5 }] 배열이고, 빈 배열이면 "업데이트 없음".
 * 최신 릴리스에 CyanPro-<ver>-update.zip 과 CyanPro-<ver>-update.md5 가
 * 둘 다 있어야 업데이트를 내준다. 클라이언트는 zip 을 실행 폴더에 그대로
 * 풀기 때문에, 전체 배포 zip 이 아니라 exe 만 든 zip 이어야 한다.
 */
const RELEASE_REPO = "pendulums58/CyanPro";

const parseVersion = s => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(s || "").trim());
  return m ? m.slice(1).map(Number) : null;
};
const newerThan = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

async function clientUpdate(request, env) {
  const none = () => json([]);
  const ua = request.headers.get("user-agent") || "";
  const m = /^CyanPro-Windows-(\d+\.\d+\.\d+)\b/.exec(ua);
  // 윈도우용 업데이트 파일만 만든다
  if (!m) return none();
  const current = parseVersion(m[1]);

  const gh = { "user-agent": "cyanpro-stats", accept: "application/vnd.github+json" };
  if (env.GITHUB_TOKEN) gh.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  // 익명 API 는 시간당 60회라 5분 캐시한다
  const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`,
    { headers: gh, cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) {
    console.log(`update: GitHub API returned ${res.status}`);
    return none();
  }
  const release = await res.json();
  const latest = parseVersion(release.tag_name);
  if (!latest) {
    console.log(`update: unparseable tag ${release.tag_name}`);
    return none();
  }
  if (!newerThan(latest, current)) return none();

  const ver = latest.join(".");
  const assets = release.assets || [];
  const zip = assets.find(a => a.name === `CyanPro-${ver}-update.zip`);
  const md5Asset = assets.find(a => a.name === `CyanPro-${ver}-update.md5`);
  if (!zip || !md5Asset) {
    console.log(`update: release ${release.tag_name} has no update zip/md5`);
    return none();
  }
  const md5Res = await fetch(md5Asset.browser_download_url,
    { cf: { cacheTtl: 3600, cacheEverything: true } });
  const md5 = md5Res.ok ? (await md5Res.text()).trim().split(/\s+/)[0].toLowerCase() : "";
  if (!/^[0-9a-f]{32}$/.test(md5)) {
    console.log(`update: bad md5 asset for ${release.tag_name}`);
    return none();
  }
  return json([{ name: zip.name, url: zip.browser_download_url, md5 }]);
}

/* ---------- 라우팅 ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const siteOrigin = env.ALLOWED_ORIGIN || "*";
    const reqOrigin = request.headers.get("origin");
    // 통계 읽기는 어디서든, 관리 화면은 지정한 사이트에서만
    const origin = reqOrigin === siteOrigin ? siteOrigin : "*";

    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    try {
      if (url.pathname === "/duels" && request.method === "POST")
        return await ingest(request, env, origin);

      if (url.pathname === "/stats/cards" && request.method === "GET")
        return await cardStats(env, origin, url);

      if (url.pathname === "/stats/summary" && request.method === "GET")
        return await summary(env, origin);

      if (url.pathname === "/stats/decks" && request.method === "GET")
        return await deckStats(env, origin, url);

      if (url.pathname === "/update" && request.method === "GET")
        return await clientUpdate(request, env);

      if (url.pathname.startsWith("/admin/")) {
        if (!adminOk(request, env))
          return json({ error: "권한이 없다" }, 401, origin);
        if (url.pathname === "/admin/duels" && request.method === "GET")
          return await adminDuels(request, env, origin, url);
        if (url.pathname === "/admin/hide" && request.method === "POST")
          return await adminHide(request, env, origin);
      }

      return json({ error: "없는 경로" }, 404, origin);
    } catch (err) {
      return json({ error: "서버 오류", detail: String(err && err.message) }, 500, origin);
    }
  },
};
