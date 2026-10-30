/* CyanPro 듀얼 통계 수집기 (Cloudflare Worker + D1)
 *
 * POST /duels        CyanPro 호스트가 듀얼 결과를 보낸다
 * GET  /stats/cards  카드별 채용률·승률
 * GET  /stats/summary 전체 요약
 * GET  /admin/duels  최근 기록 (관리자 토큰 필요)
 * POST /admin/hide   잘못된 기록 숨기기 (관리자 토큰 필요)
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
  return { ok: true, id, winner };
}

function tally(list) {
  const m = new Map();
  for (const c of list || []) m.set(c, (m.get(c) || 0) + 1);
  return m;
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
                          version, reporter, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      check.id,
      body.match_id ? String(body.match_id).slice(0, 64) : null,
      Number.isFinite(Number(body.game_no)) ? Number(body.game_no) : null,
      body.format ? String(body.format).slice(0, 80) : null,
      check.winner,
      ended,
      body.version ? String(body.version).slice(0, 40) : null,
      body.reporter ? String(body.reporter).slice(0, 64) : null,
      now),
  ];

  for (const p of body.players) {
    const seat = Number(p.seat);
    stmts.push(env.DB.prepare(
      "INSERT INTO duel_players (duel_id, seat, name, won) VALUES (?, ?, ?, ?)")
      .bind(check.id, seat, p.name ? String(p.name).slice(0, 60) : null,
            seat === check.winner ? 1 : 0));   // 무승부(2)면 양쪽 다 0

    for (const zone of ZONES) {
      for (const [cardId, qty] of tally((p.deck || {})[zone])) {
        stmts.push(env.DB.prepare(
          "INSERT INTO deck_cards (duel_id, seat, zone, card_id, qty) VALUES (?, ?, ?, ?, ?)")
          .bind(check.id, seat, zone, cardId, qty));
      }
    }
  }

  await env.DB.batch(stmts);
  return json({ ok: true, duel_id: check.id }, 201, origin);
}

/* ---------- 카드별 통계 ---------- */
async function cardStats(env, origin, url) {
  const zoneFilter = url.searchParams.get("zone") === "all"
    ? ZONES : ["main", "extra"];
  const placeholders = zoneFilter.map(() => "?").join(",");

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
      WHERE d.hidden = 0
      GROUP BY dc.card_id`).bind(...zoneFilter).all();

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS decks,
            COUNT(DISTINCT dp.duel_id) AS duels
       FROM duel_players dp
       JOIN duels d ON d.duel_id = dp.duel_id
      WHERE d.hidden = 0`).first();

  return json({
    total_decks: totals ? totals.decks : 0,
    total_duels: totals ? totals.duels : 0,
    cards: (rows.results || []).map(r => ({
      id: r.card_id,
      decks: r.decks,
      wins: r.wins,
      decided: r.decided,
      copies: r.copies,
    })),
  }, 200, origin);
}

async function summary(env, origin) {
  const d = await env.DB.prepare(
    `SELECT COUNT(*) AS duels,
            MIN(ended_at) AS first_at,
            MAX(ended_at) AS last_at
       FROM duels WHERE hidden = 0`).first();
  const hidden = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM duels WHERE hidden = 1").first();
  const formats = await env.DB.prepare(
    `SELECT format, COUNT(*) AS n FROM duels WHERE hidden = 0
      GROUP BY format ORDER BY n DESC LIMIT 20`).all();
  return json({
    duels: d ? d.duels : 0,
    first_at: d ? d.first_at : null,
    last_at: d ? d.last_at : null,
    hidden: hidden ? hidden.n : 0,
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
