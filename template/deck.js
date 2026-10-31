/* 덱 에디터 — 카드 풀에서 골라 메인 / 엑스트라 / 사이드를 짠다.
 *
 * 저장은 브라우저(localStorage), 공유는 URL 인코딩, 교환은 .ydk 다.
 * 매수 제한은 "명칭" 단위(card.family)로 센다. 일러스트가 달라도 같은 카드다.
 * index.html 이 ctx 로 데이터와 헬퍼를 넘겨준다.
 */
(function (global) {
  "use strict";

  const MAIN_MIN = 40, MAIN_MAX = 60, EXTRA_MAX = 15, SIDE_MAX = 15;
  const DEFAULT_COPIES = 3;
  const STORE_KEY = "orica_decks";
  const LAST_KEY = "orica_deck_last";
  const UNDO_MAX = 40;

  let ctx = null;            // index.html 이 넘긴 데이터와 헬퍼
  let deck = blank();        // 편집 중인 덱
  let target = "auto";       // auto(메인·엑스트라) | side — 추가 대상
  let undoStack = [];
  let poolQuery = "";
  let poolKinds = new Set();
  let poolSort = "number";   // number | name | usage
  let poolZone = "all";      // all | main | extra
  let notice = null;         // 방금 한 동작에 대한 한 줄 안내

  function blank() { return { name: "새 덱", main: [], extra: [], side: [] }; }
  const el = (...a) => ctx.el(...a);
  const zones = () => [deck.main, deck.extra, deck.side];

  /* ---------- 매수 세기와 규칙 ---------- */

  const famOf = id => {
    const c = ctx.byId.get(id);
    return c ? (c.family || id) : id;
  };

  /* 이 명칭을 덱 전체에서 몇 장 쓰고 있나 */
  function countFamily(fam) {
    let n = 0;
    for (const z of zones()) for (const id of z) if (famOf(id) === fam) n++;
    return n;
  }

  /* 금제가 정한 이 명칭의 허용 매수 */
  function allowedFor(fam) {
    const lim = ctx.lflist && ctx.lflist.limits ? ctx.lflist.limits.get(fam) : undefined;
    return lim === undefined ? DEFAULT_COPIES : lim;
  }

  function zoneCap(which) {
    return which === "main" ? MAIN_MAX : which === "extra" ? EXTRA_MAX : SIDE_MAX;
  }

  /* 이 카드를 지금 어느 존에 넣을 수 있나. 넣을 수 없으면 이유를 돌려준다 */
  function placeFor(card) {
    const fam = card.family || card.id;
    const allowed = allowedFor(fam);
    if (allowed === 0) return { error: `${card.name} 은 금지 카드다` };
    if (countFamily(fam) >= allowed)
      return { error: `${card.name} 은 ${allowed}장까지다` };

    const natural = card.deck === "extra" ? "extra" : "main";
    const order = target === "side" ? ["side", natural] : [natural, "side"];
    for (const which of order) {
      if (deck[which].length < zoneCap(which)) return { zone: which };
    }
    const label = natural === "extra" ? "엑스트라" : "메인";
    return { error: `${label} 덱과 사이드 덱이 모두 찼다` };
  }

  /* 덱 전체를 검사한다. 치명적 오류와 경고를 나눈다 */
  function validate() {
    const errors = [], warns = [];
    if (deck.main.length < MAIN_MIN)
      (deck.main.length ? errors : warns).push(
        `메인 덱이 ${deck.main.length}장이다 — 최소 ${MAIN_MIN}장`);
    if (deck.main.length > MAIN_MAX) errors.push(`메인 덱이 ${MAIN_MAX}장을 넘었다`);
    if (deck.extra.length > EXTRA_MAX) errors.push(`엑스트라 덱이 ${EXTRA_MAX}장을 넘었다`);
    if (deck.side.length > SIDE_MAX) errors.push(`사이드 덱이 ${SIDE_MAX}장을 넘었다`);

    const seen = new Map();
    for (const z of zones()) for (const id of z) {
      const f = famOf(id);
      seen.set(f, (seen.get(f) || 0) + 1);
    }
    for (const [fam, n] of seen) {
      const allowed = allowedFor(fam);
      const c = ctx.byId.get(fam) || ctx.byId.get([...zones().flat()].find(i => famOf(i) === fam));
      const nm = c ? c.name : `ID ${fam}`;
      if (n > allowed)
        errors.push(allowed === 0 ? `${nm} 은 금지 카드다` : `${nm} 이 ${n}장이다 — ${allowed}장까지`);
    }

    // 잘못된 존에 들어간 카드 (주로 .ydk 를 들여올 때 생긴다)
    for (const [which, label] of [["main", "메인"], ["extra", "엑스트라"]]) {
      const wrong = deck[which].filter(id => {
        const c = ctx.byId.get(id);
        return c && (c.deck === "extra") !== (which === "extra");
      });
      if (wrong.length) {
        const names = [...new Set(wrong.map(i => (ctx.byId.get(i) || {}).name))].join(", ");
        errors.push(`${label} 덱에 들어갈 수 없는 카드가 있다: ${names}`);
      }
    }

    const unknown = zones().flat().filter(id => !ctx.byId.get(id));
    if (unknown.length)
      warns.push(`카드 풀에 없는 ID ${[...new Set(unknown)].length}종이 들어 있다`);

    return { errors, warns, ok: !errors.length };
  }

  /* ---------- 덱 고치기 ---------- */

  function snapshot() {
    undoStack.push(JSON.stringify(deck));
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }

  function add(card) {
    const spot = placeFor(card);
    if (spot.error) { notice = spot.error; paint(); return; }
    snapshot();
    deck[spot.zone].push(card.id);
    sortZone(spot.zone);
    notice = null;
    touch();
  }

  function removeOne(which, id) {
    const i = deck[which].lastIndexOf(id);
    if (i < 0) return;
    snapshot();
    deck[which].splice(i, 1);
    notice = null;
    touch();
  }

  function moveCard(from, id) {
    const to = from === "side" ? ((ctx.byId.get(id) || {}).deck === "extra" ? "extra" : "main") : "side";
    if (deck[to].length >= zoneCap(to)) {
      notice = `${to === "side" ? "사이드" : to === "extra" ? "엑스트라" : "메인"} 덱이 찼다`;
      paint(); return;
    }
    snapshot();
    deck[from].splice(deck[from].lastIndexOf(id), 1);
    deck[to].push(id);
    sortZone(to);
    notice = null;
    touch();
  }

  function undo() {
    if (!undoStack.length) { notice = "되돌릴 것이 없다"; paint(); return; }
    deck = JSON.parse(undoStack.pop());
    notice = null;
    touch(true);
  }

  /* 존 안에서 보기 좋게: 몬스터 → 마법 → 함정, 그 안에서 이름순 */
  const KIND_RANK = c => {
    if (!c) return 9;
    if (c.types.includes("마법")) return 1;
    if (c.types.includes("함정")) return 2;
    return 0;
  };
  function sortZone(which) {
    deck[which].sort((a, b) => {
      const ca = ctx.byId.get(a), cb = ctx.byId.get(b);
      const ka = KIND_RANK(ca), kb = KIND_RANK(cb);
      if (ka !== kb) return ka - kb;
      const na = ca ? ca.name : String(a), nb = cb ? cb.name : String(b);
      return na.localeCompare(nb, "ko") || a - b;
    });
  }

  /* 고칠 때마다 저장하고 주소를 갱신한다 */
  function touch(skipSort) {
    if (!skipSort) for (const w of ["main", "extra", "side"]) sortZone(w);
    saveLast();
    paint();
  }

  /* ---------- 저장 ---------- */

  const readStore = () => {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; }
    catch { return {}; }
  };
  const writeStore = obj => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(obj)); return true; }
    catch { return false; }
  };
  const saveLast = () => {
    try { localStorage.setItem(LAST_KEY, JSON.stringify(deck)); } catch {}
  };
  const loadLast = () => {
    try {
      const d = JSON.parse(localStorage.getItem(LAST_KEY) || "null");
      return d && Array.isArray(d.main) ? normalize(d) : null;
    } catch { return null; }
  };

  function normalize(d) {
    const arr = x => (Array.isArray(x) ? x.map(Number).filter(Number.isInteger) : []);
    return { name: String(d.name || "새 덱").slice(0, 60),
             main: arr(d.main), extra: arr(d.extra), side: arr(d.side) };
  }

  function saveNamed() {
    const name = (prompt("덱 이름", deck.name) || "").trim();
    if (!name) return;
    deck.name = name.slice(0, 60);
    const store = readStore();
    store[name] = { ...deck, name, saved: Date.now() };
    notice = writeStore(store)
      ? `"${name}" 으로 저장했다`
      : "브라우저 저장이 막혀 있어 저장하지 못했다";
    saveLast();
    paint();
  }

  /* ---------- URL 공유 ---------- */

  /* 덱 이름은 한글이 들어가므로 UTF-8 로 바꾼 뒤 base64url 로 싣는다.
     폐기된 escape / unescape 는 쓰지 않는다. */
  const b64url = {
    enc(s) {
      const bytes = new TextEncoder().encode(s);
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
    dec(s) {
      const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    },
  };

  /* 같은 ID 가 반복되므로 "id36*매수" 로 묶는다 */
  function packZone(ids) {
    const counts = new Map();
    for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
    return [...counts].map(([id, n]) => id.toString(36) + (n > 1 ? "*" + n : "")).join(".");
  }
  function unpackZone(text) {
    const out = [];
    for (const tok of String(text || "").split(".")) {
      if (!tok) continue;
      const [a, b] = tok.split("*");
      const id = parseInt(a, 36);
      if (!Number.isInteger(id)) continue;
      const n = b ? Math.min(parseInt(b, 10) || 1, 60) : 1;
      for (let i = 0; i < n; i++) out.push(id);
    }
    return out;
  }

  function encodeDeck(d) {
    return ["1", b64url.enc(d.name || ""),
            packZone(d.main), packZone(d.extra), packZone(d.side)].join("~");
  }
  function decodeDeck(payload) {
    const parts = String(payload || "").split("~");
    if (parts[0] !== "1") return null;
    let name = "공유받은 덱";
    try { if (parts[1]) name = b64url.dec(parts[1]); } catch {}
    return normalize({ name, main: unpackZone(parts[2]),
                       extra: unpackZone(parts[3]), side: unpackZone(parts[4]) });
  }

  function shareUrl() {
    return location.origin + location.pathname + "#deck=" + encodeDeck(deck);
  }

  /* ---------- .ydk ---------- */

  function toYdk() {
    const lines = ["#created by " + (deck.name || "오리카"), "#main"];
    for (const id of deck.main) lines.push(String(id));
    lines.push("#extra");
    for (const id of deck.extra) lines.push(String(id));
    lines.push("!side");
    for (const id of deck.side) lines.push(String(id));
    return lines.join("\n") + "\n";
  }

  function fromYdk(text) {
    const out = { name: "", main: [], extra: [], side: [] };
    let cur = null;
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^#created by/i.test(line)) { out.name = line.replace(/^#created by\s*/i, "").trim(); continue; }
      if (/^#main/i.test(line)) { cur = "main"; continue; }
      if (/^#extra/i.test(line)) { cur = "extra"; continue; }
      if (/^[!#]side/i.test(line)) { cur = "side"; continue; }
      if (line.startsWith("#") || line.startsWith("!")) continue;
      const id = parseInt(line, 10);
      if (cur && Number.isInteger(id)) out[cur].push(id);
    }
    if (!out.main.length && !out.extra.length && !out.side.length) return null;
    if (!out.name) out.name = "들여온 덱";
    return normalize(out);
  }

  function download(name, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- 채용률 ---------- */

  function usageOf(card) {
    const s = ctx.getStats && ctx.getStats();
    if (!s || !s.total_decks) return null;
    // 통계는 실제 ID 기준이므로 같은 명칭의 일러스트들을 합친다
    let decks = 0;
    for (const a of (card.arts && card.arts.length ? card.arts.map(x => x.id) : [card.id])) {
      const row = s.byId.get(a);
      if (row) decks += row.decks;
    }
    if (!decks) return null;
    return Math.min(1, decks / s.total_decks);
  }

  /* ---------- 그리기 ---------- */

  let host = null;
  let poolGridEl = null, poolMetaEl = null;

  function render(view, context) {
    ctx = context;
    host = view;

    // 주소에 덱이 실려 오면 그걸 연다. 아니면 직전에 편집하던 덱.
    if (ctx.hashPayload) {
      const d = decodeDeck(ctx.hashPayload);
      if (d) { deck = d; undoStack = []; notice = "주소로 받은 덱을 열었다 — 저장은 따로 해야 한다"; }
      else notice = "주소의 덱 데이터를 읽지 못했다";
    } else if (!deck.main.length && !deck.extra.length && !deck.side.length) {
      const last = loadLast();
      if (last) deck = last;
    }
    for (const w of ["main", "extra", "side"]) sortZone(w);
    paint();

    // 채용률은 늦게 와도 되므로 뒤이어 받아 다시 칠한다
    if (ctx.loadStats && !(ctx.getStats && ctx.getStats())) {
      ctx.loadStats().then(s => { if (s && host === view) paint(); }).catch(() => {});
    }
  }

  function paint() {
    if (!host) return;
    const keepQuery = document.activeElement && document.activeElement.id === "deckSearch";
    const caret = keepQuery ? document.activeElement.selectionStart : null;

    host.textContent = "";
    host.append(headBlock(), deckBlock(), poolBlock());

    if (keepQuery) {
      const f = document.getElementById("deckSearch");
      if (f) { f.focus(); try { f.setSelectionRange(caret, caret); } catch {} }
    }
  }

  /* 제목 · 매수 · 검사 결과 · 버튼들 */
  function headBlock() {
    const wrap = el("div", "pagehead");
    wrap.append(el("h2", null, "덱 에디터"));

    const nameRow = el("div", "dknamerow");
    const nm = el("input", "dkname");
    nm.type = "text";
    nm.value = deck.name;
    nm.maxLength = 60;
    nm.setAttribute("aria-label", "덱 이름");
    nm.addEventListener("change", () => { deck.name = nm.value.trim() || "새 덱"; saveLast(); });
    nameRow.append(nm);

    const counts = el("span", "dkcounts");
    const tag = (label, n, max, min) => {
      const bad = n > max || (min != null && n && n < min);
      const s = el("span", "dkc" + (bad ? " bad" : ""));
      s.append(el("b", null, label), document.createTextNode(` ${n}/${max}`));
      return s;
    };
    counts.append(tag("메인", deck.main.length, MAIN_MAX, MAIN_MIN),
                  tag("엑스트라", deck.extra.length, EXTRA_MAX),
                  tag("사이드", deck.side.length, SIDE_MAX));
    nameRow.append(counts);
    wrap.append(nameRow);

    const bar = el("div", "dkactions");
    const btn = (label, fn, cls) => {
      const b = el("button", "dkbtn" + (cls ? " " + cls : ""), label);
      b.addEventListener("click", fn);
      return b;
    };

    bar.append(btn("저장", saveNamed, "primary"));
    bar.append(btn("불러오기", openLoadPanel));
    bar.append(btn("공유 링크", () => {
      const url = shareUrl();
      const done = () => { notice = "공유 링크를 복사했다"; paint(); };
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(url).then(done, () => { prompt("공유 링크", url); });
      else prompt("공유 링크", url);
    }));
    bar.append(btn(".ydk 내보내기", () => {
      download((deck.name || "deck").replace(/[\\/:*?"<>|]/g, "_") + ".ydk", toYdk());
      notice = ".ydk 를 내려받았다";
      paint();
    }));
    bar.append(btn(".ydk 들여오기", openImportPanel));
    bar.append(btn("되돌리기", undo));
    bar.append(btn("비우기", () => {
      if (!confirm("편집 중인 덱을 비운다. 저장해 둔 덱은 그대로다.")) return;
      snapshot();
      deck = blank();
      notice = null;
      touch(true);
    }, "warn"));
    wrap.append(bar);

    // 추가 대상
    const seg = el("div", "dkseg");
    seg.append(el("span", "lbl", "클릭하면 넣을 곳"));
    for (const [v, label] of [["auto", "메인 · 엑스트라"], ["side", "사이드"]]) {
      const b = el("button", "segb", label);
      b.setAttribute("aria-pressed", target === v ? "true" : "false");
      b.addEventListener("click", () => { target = v; paint(); });
      seg.append(b);
    }
    wrap.append(seg);

    const v = validate();
    if (notice) wrap.append(el("p", "dknotice", notice));
    if (v.errors.length || v.warns.length) {
      const box = el("div", "dkcheck" + (v.errors.length ? " bad" : ""));
      box.append(el("b", null, v.errors.length ? "규정에 맞지 않는다" : "확인할 점"));
      const ul = el("ul");
      for (const m of v.errors) ul.append(el("li", "err", m));
      for (const m of v.warns) ul.append(el("li", null, m));
      box.append(ul);
      wrap.append(box);
    } else if (deck.main.length) {
      wrap.append(el("p", "dkok", "규정에 맞는 덱이다"));
    }

    if (ctx.lflist && ctx.lflist.name) {
      const p = el("p", "dklf");
      p.append(document.createTextNode("적용 중인 금제: " + ctx.lflist.name));
      if (ctx.lflist.limits && ctx.lflist.limits.size)
        p.append(document.createTextNode(` · ${ctx.lflist.limits.size}종 지정`));
      else p.append(document.createTextNode(" · 지정된 카드 없음"));
      wrap.append(p);
    }
    return wrap;
  }

  /* 세 존 */
  function deckBlock() {
    const wrap = el("div", "dkzones");
    for (const [which, label, max] of [["main", "메인 덱", MAIN_MAX],
                                       ["extra", "엑스트라 덱", EXTRA_MAX],
                                       ["side", "사이드 덱", SIDE_MAX]]) {
      const box = el("section", "dkzone");
      const h = el("div", "zh");
      h.append(el("h3", null, label), el("span", "zn", `${deck[which].length} / ${max}`));
      box.append(h);

      const ul = el("ul", "dktiles");
      if (!deck[which].length) {
        ul.append(el("li", "dkempty",
          which === "side" ? "비어 있다" : "아래 카드 풀에서 눌러 넣는다"));
      } else {
        // 같은 카드는 한 칸에 모으고 매수를 표시한다
        const groups = [];
        for (const id of deck[which]) {
          const last = groups[groups.length - 1];
          if (last && last.id === id) last.n++;
          else groups.push({ id, n: 1 });
        }
        for (const g of groups) ul.append(deckTile(which, g.id, g.n));
      }
      box.append(ul);
      wrap.append(box);
    }
    return wrap;
  }

  function deckTile(which, id, n) {
    const c = ctx.byId.get(id);
    const li = el("li");
    const b = el("button", "dktile" + (c ? "" : " ghost"));
    b.style.setProperty("--fc", c ? ctx.frameVar(c) : "var(--fg-faint)");
    if (c && c.img) {
      const im = el("img"); im.src = c.img; im.alt = c.name; im.loading = "lazy";
      b.append(im);
    } else {
      b.append(el("span", "nopic", c ? c.name : String(id)));
    }
    if (n > 1) b.append(el("span", "cnt", "×" + n));
    const allowed = c ? allowedFor(c.family || c.id) : DEFAULT_COPIES;
    if (allowed < DEFAULT_COPIES) b.append(el("span", "lim l" + allowed, String(allowed)));
    b.title = (c ? c.name : "ID " + id) + " — 누르면 1장 뺀다";
    b.addEventListener("click", () => removeOne(which, id));

    // 사이드와 본덱 사이로 옮기기
    const mv = el("button", "dkmove", which === "side" ? "↑" : "↓");
    mv.title = which === "side" ? "본덱으로 옮긴다" : "사이드로 옮긴다";
    mv.addEventListener("click", e => { e.stopPropagation(); moveCard(which, id); });

    const info = el("button", "dkinfo", "ⓘ");
    info.title = "카드 정보";
    info.addEventListener("click", e => { e.stopPropagation(); if (c) ctx.openCard(c); });

    const cell = el("div", "dkcell");
    cell.append(b, mv);
    if (c) cell.append(info);
    li.append(cell);
    return li;
  }

  /* 카드 풀 */
  function poolBlock() {
    const wrap = el("section", "dkpool");
    wrap.append(el("h3", null, "카드 풀"));

    const bar = el("div", "toolbar");
    const f = el("input", "filter");
    f.type = "search";
    f.id = "deckSearch";
    f.placeholder = "카드명 · 번호 · 텍스트 검색";
    f.value = poolQuery;
    f.addEventListener("input", () => { poolQuery = f.value; redrawPool(); });
    bar.append(f);

    const sort = el("select", "dksort");
    for (const [v, label] of [["number", "번호순"], ["name", "이름순"], ["usage", "채용률순"]]) {
      const o = el("option", null, label); o.value = v;
      if (poolSort === v) o.selected = true;
      sort.append(o);
    }
    sort.addEventListener("change", () => { poolSort = sort.value; redrawPool(); });
    bar.append(sort);
    wrap.append(bar);

    const chips = el("div", "chiprow");
    for (const [v, label] of [["all", "전체"], ["main", "메인 덱"], ["extra", "엑스트라 덱"]]) {
      const b = el("button", "fchip" + (poolZone === v ? " on" : ""));
      b.setAttribute("aria-pressed", poolZone === v ? "true" : "false");
      b.append(document.createTextNode(label));
      b.addEventListener("click", () => { poolZone = v; redrawPool(); paintChips(); });
      chips.append(b);
    }
    const kinds = [
      ["액세스", "--f-access"], ["페어링", "--f-pairing"], ["기프트", "--f-gift"],
      ["키", "--f-key"], ["융합", "--f-fusion"], ["싱크로", "--f-synchro"],
      ["엑시즈", "--f-xyz"], ["링크", "--f-link"],
      ["마법", "--f-spell"], ["함정", "--f-trap"],
    ].filter(([k]) => ctx.allCards.some(c => c.types.includes(k)));
    for (const [k, color] of kinds) {
      const b = el("button", "fchip");
      b.setAttribute("aria-pressed", poolKinds.has(k) ? "true" : "false");
      const dot = el("span", "dot");
      dot.style.setProperty("--sw", `var(${color})`);
      b.append(dot, document.createTextNode(k));
      b.addEventListener("click", () => {
        poolKinds.has(k) ? poolKinds.delete(k) : poolKinds.add(k);
        b.setAttribute("aria-pressed", poolKinds.has(k) ? "true" : "false");
        redrawPool();
      });
      chips.append(b);
    }
    wrap.append(chips);

    poolGridEl = el("ul", "cardgrid dkpoolgrid");
    poolGridEl.id = "deckPoolGrid";
    wrap.append(poolGridEl);
    poolMetaEl = el("p", "dkpoolmeta");
    wrap.append(poolMetaEl);

    // 칩의 눌린 상태만 다시 칠한다
    function paintChips() {
      [...chips.children].slice(0, 3).forEach((b, i) => {
        const v = ["all", "main", "extra"][i];
        b.setAttribute("aria-pressed", poolZone === v ? "true" : "false");
        b.classList.toggle("on", poolZone === v);
      });
    }

    redrawPool();
    return wrap;
  }

  function poolHits() {
    const q = poolQuery.trim().toLowerCase();
    let hits = ctx.allCards.filter(c => {
      if (poolZone !== "all" && (c.deck === "extra" ? "extra" : "main") !== poolZone) return false;
      if (poolKinds.size && ![...poolKinds].some(k => c.types.includes(k))) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q)
        || (c.number || "").toLowerCase().includes(q)
        || String(c.id).includes(q)
        || (c.text || "").toLowerCase().includes(q);
    });
    // 같은 명칭의 일러스트 변형은 대표 하나만 보여준다
    const byFam = new Map();
    for (const c of hits) {
      const f = c.family || c.id;
      if (!byFam.has(f) || c.id < byFam.get(f).id) byFam.set(f, c);
    }
    hits = [...byFam.values()];

    if (poolSort === "name") hits.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    else if (poolSort === "usage")
      hits.sort((a, b) => (usageOf(b) || -1) - (usageOf(a) || -1) || a.name.localeCompare(b.name, "ko"));
    else hits.sort((a, b) => (a.number || "zzz").localeCompare(b.number || "zzz") || a.id - b.id);
    return hits;
  }

  function redrawPool() {
    const ul = poolGridEl, meta = poolMetaEl;
    if (!ul) return;
    ul.textContent = "";
    const hits = poolHits();
    if (!hits.length) { ul.append(el("li", "empty", "조건에 맞는 카드가 없다.")); }
    else for (const c of hits) ul.append(poolTile(c));
    if (meta) {
      const s = ctx.getStats && ctx.getStats();
      meta.textContent = `${hits.length}종 표시`
        + (s && s.total_decks ? ` · 채용률은 집계된 덱 ${s.total_decks}개 기준` : "");
    }
  }

  function poolTile(c) {
    const li = el("li");
    const b = el("button", "cardcell dkpick");
    b.style.setProperty("--fc", ctx.frameVar(c));
    b.append(el("div", "strip"));

    const pic = el("div", "pic");
    if (c.img) { const im = el("img"); im.src = c.img; im.alt = c.name; im.loading = "lazy"; pic.append(im); }
    const badge = ctx.attrBadge(c.attribute);
    if (badge) pic.append(badge);

    const fam = c.family || c.id;
    const used = countFamily(fam);
    const allowed = allowedFor(fam);
    if (used) pic.append(el("span", "inuse", `${used}장 넣음`));
    if (allowed < DEFAULT_COPIES) pic.append(el("span", "lim l" + allowed, String(allowed)));
    const rate = usageOf(c);
    if (rate != null) pic.append(el("span", "rate", Math.round(rate * 100) + "%"));
    b.append(pic);

    const cap = el("div", "cap");
    if (c.number) cap.append(el("span", "no", c.number));
    cap.append(el("span", "nm", c.name));
    b.append(cap);

    if (used >= allowed) b.classList.add("maxed");
    b.title = allowed === 0 ? `${c.name} — 금지 카드` : `${c.name} — 누르면 넣는다 (${used}/${allowed})`;
    b.addEventListener("click", () => add(c));

    const info = el("button", "dkinfo", "ⓘ");
    info.title = "카드 정보";
    info.addEventListener("click", e => { e.stopPropagation(); ctx.openCard(c); });

    const cell = el("div", "dkcell");
    cell.append(b, info);
    li.append(cell);
    return li;
  }

  /* ---------- 불러오기 / 들여오기 ---------- */

  function openLoadPanel() {
    const store = readStore();
    const names = Object.keys(store).sort((a, b) => (store[b].saved || 0) - (store[a].saved || 0));
    const body = el("div", "dkpanel");
    body.append(el("h3", null, "저장해 둔 덱"));
    if (!names.length) {
      body.append(el("p", "dkpnote", "저장한 덱이 없다. 저장 버튼을 누르면 이 브라우저에 보관한다."));
    } else {
      const ul = el("ul", "dksaved");
      for (const n of names) {
        const d = store[n];
        const li = el("li");
        const open = el("button", "dkbtn", n);
        open.addEventListener("click", () => {
          snapshot();
          deck = normalize(d);
          notice = `"${n}" 을 열었다`;
          closePanel();
          touch(true);
        });
        const meta = el("span", "m",
          `메인 ${(d.main || []).length} · 엑스트라 ${(d.extra || []).length} · 사이드 ${(d.side || []).length}`);
        const del = el("button", "dkbtn warn", "삭제");
        del.addEventListener("click", () => {
          if (!confirm(`"${n}" 을 지운다.`)) return;
          const s2 = readStore(); delete s2[n]; writeStore(s2);
          closePanel(); openLoadPanel();
        });
        li.append(open, meta, del);
        ul.append(li);
      }
      body.append(ul);
    }
    showPanel(body);
  }

  function openImportPanel() {
    const body = el("div", "dkpanel");
    body.append(el("h3", null, ".ydk 들여오기"));
    body.append(el("p", "dkpnote",
      "파일을 고르거나 내용을 붙여 넣는다. 카드 풀에 없는 ID 는 그대로 두고 경고만 띄운다."));

    const file = el("input");
    file.type = "file";
    file.accept = ".ydk,.txt,text/plain";
    file.addEventListener("change", () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => applyImport(fromYdk(rd.result), f.name.replace(/\.ydk$/i, ""));
      rd.readAsText(f);
    });
    body.append(file);

    const ta = el("textarea", "dkta");
    ta.rows = 10;
    ta.placeholder = "#main\n12345678\n...";
    body.append(ta);

    const go = el("button", "dkbtn primary", "들여오기");
    go.addEventListener("click", () => applyImport(fromYdk(ta.value), null));
    body.append(go);
    showPanel(body);
  }

  function applyImport(d, fallbackName) {
    if (!d) { notice = ".ydk 를 읽지 못했다"; closePanel(); paint(); return; }
    if (fallbackName && (!d.name || d.name === "들여온 덱")) d.name = fallbackName;
    snapshot();
    deck = d;
    const v = validate();
    notice = `${d.name} 을 들여왔다`
      + (v.errors.length ? ` — 규정 문제 ${v.errors.length}건을 아래에 적었다` : "");
    closePanel();
    touch(true);
  }

  let panel = null;
  function showPanel(body) {
    closePanel();
    panel = el("div", "dkscrim");
    const box = el("div", "dkbox");
    const close = el("button", "dkclose", "닫기");
    close.addEventListener("click", closePanel);
    box.append(close, body);
    panel.append(box);
    panel.addEventListener("click", e => { if (e.target === panel) closePanel(); });
    document.body.append(panel);
  }
  function closePanel() {
    if (panel) { panel.remove(); panel = null; }
  }

  global.OricaDeck = { render, encodeDeck, decodeDeck, toYdk, fromYdk, validate: () => validate() };
})(typeof window !== "undefined" ? window : globalThis);
