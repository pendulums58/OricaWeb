/* 오리카 카드 디코더 — 이 파일이 유일한 해석기다.
 *
 * cdb 의 비트 필드와 효과 설명 꼬리를 읽어 카드 객체로 만든다.
 * 브라우저가 sql.js 로 cdb 를 직접 열어 이 함수들을 쓴다.
 */
(function (global) {
  "use strict";

  const NUMBER = /^\[([A-Z0-9]{3,6})-([A-Z]{2})(\d{3})\]$/;
  const LABELLED = /^\[\s*([^\[\]:：]+?)\s*[:：]\s*(.*?)\s*\]$/;
  const PLAIN = /^\[\s*([^\[\]]+?)\s*\]$/;

  const TYPE_BITS = [
    [0x1, "몬스터", null], [0x2, "마법", "spell"], [0x4, "함정", "trap"],
    [0x10, "일반", "normal"], [0x20, "효과", "effect"],
    [0x40, "융합", "fusion"], [0x80, "의식", "ritual"],
    [0x100, "함정 몬스터", null], [0x200, "스피릿", null],
    [0x400, "유니온", null], [0x800, "듀얼", null], [0x1000, "튜너", null],
    [0x2000, "싱크로", "synchro"], [0x4000, "토큰", null],
    [0x10000, "속공", null], [0x20000, "지속", null], [0x40000, "장착", null],
    [0x80000, "필드", null], [0x100000, "카운터", null],
    [0x200000, "리버스", null], [0x400000, "툰", null],
    [0x800000, "엑시즈", "xyz"], [0x1000000, "펜듈럼", null],
    [0x2000000, "특수 소환", null], [0x4000000, "링크", "link"],
  ];
  let KNOWN_TYPE_MASK = 0;
  for (const [bit] of TYPE_BITS) KNOWN_TYPE_MASK |= bit;

  const FRAME_ORDER = ["access", "pairing", "gift", "key", "hijack", "link",
                       "xyz", "synchro", "fusion", "ritual", "spell", "trap",
                       "effect", "normal"];

  const ATTRIBUTES = [[0x1, "땅"], [0x2, "물"], [0x4, "불"], [0x8, "바람"],
                      [0x10, "빛"], [0x20, "어둠"], [0x40, "신"]];

  const RACES = [
    [0x1, "전사족"], [0x2, "마법사족"], [0x4, "천사족"], [0x8, "악마족"],
    [0x10, "언데드족"], [0x20, "기계족"], [0x40, "물족"], [0x80, "화염족"],
    [0x100, "암석족"], [0x200, "비행야수족"], [0x400, "식물족"], [0x800, "곤충족"],
    [0x1000, "번개족"], [0x2000, "드래곤족"], [0x4000, "야수족"],
    [0x8000, "야수전사족"], [0x10000, "공룡족"], [0x20000, "어류족"],
    [0x40000, "해룡족"], [0x80000, "파충류족"], [0x100000, "사이킥족"],
    [0x200000, "환신야수족"], [0x400000, "창조신족"], [0x800000, "환룡족"],
    [0x1000000, "사이버스족"], [0x2000000, "환상마족"], [0x4000000, "사이보그족"],
    [0x8000000, "마법기사족"], [0x10000000, "고룡족"], [0x20000000, "오메가사이킥족"],
    [0x40000000, "천위족"], [0x80000000, "갤럭시족"],
  ];
  // 요괴족(0x4000000000000000)은 53비트를 넘어 BigInt 로 따로 본다
  const RACE_YOKAI = 0x4000000000000000n;

  const LINK_MARKERS = [[0x1, "↙"], [0x2, "↓"], [0x4, "↘"], [0x8, "←"],
                        [0x20, "→"], [0x40, "↖"], [0x80, "↑"], [0x100, "↗"]];

  const TYPE_UNLOCKED = 0x8000;
  const TYPE_KEY = 0x8;
  const ART_SPAN = 10;

  const bits = (value, table) => table.filter(r => value & r[0]).map(r => r[1]);
  const one = (value, table) => {
    for (const [bit, label] of table) if ((value >>> 0) & bit) return label;
    return null;
  };

  const raceName = value => {
    try { if (BigInt(value) & RACE_YOKAI) return "요괴족"; } catch { /* 무시 */ }
    return one(Number(value) % 0x100000000, RACES);
  };

  /* 효과 설명을 본문과 꼬리의 대괄호 줄로 나눈다 */
  function splitDesc(desc) {
    const text = String(desc || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+$/, "");
    const lines = text.split("\n");
    const meta = [];
    while (lines.length) {
      const last = lines[lines.length - 1].trim();
      if (last === "") { lines.pop(); continue; }
      if (last.startsWith("[") && last.endsWith("]")) { meta.unshift(last); lines.pop(); continue; }
      break;
    }
    return { body: lines.join("\n").trim(), meta };
  }

  /* 첫 줄은 제작자. [키 : 값] 은 라벨이고 값이 여러 개면 | 로 나눈다 */
  function parseMeta(metaLines) {
    const out = { number: null, code: null, seq: null, region: null,
                  packName: null, credits: [], labels: {} };
    metaLines.forEach((line, index) => {
      let m = NUMBER.exec(line);
      if (m) {
        out.code = m[1]; out.region = m[2]; out.seq = parseInt(m[3], 10);
        out.number = `${m[1]}-${m[2]}${m[3]}`;
        return;
      }
      m = LABELLED.exec(line);
      if (m) {
        const key = m[1].replace(/\s+/g, " ").trim();
        const values = m[2].split("|").map(v => v.trim()).filter(Boolean);
        (out.labels[key] = out.labels[key] || []).push(...values);
        return;
      }
      m = PLAIN.exec(line);
      if (m) {
        const inner = m[1].trim();
        if (!inner) return;
        if (index === 0) out.credits.push(inner);
        else out.packName = inner;
      }
    });
    return out;
  }

  /* 한 행을 카드 객체로 */
  function describe(row, source, customBits, unknownBits) {
    const { body, meta } = splitDesc(row.desc);
    const parsed = parseMeta(meta);
    const typeValue = row.type >>> 0;
    let leftover = typeValue & ~KNOWN_TYPE_MASK;
    const labels = bits(typeValue, TYPE_BITS);
    const frames = TYPE_BITS.filter(r => (typeValue & r[0]) && r[2]).map(r => r[2]);

    for (const [bit, spec] of customBits) {
      if (leftover & bit) {
        labels.push(spec.name);
        if (spec.frame) frames.push(spec.frame);
        leftover &= ~bit;
      }
    }
    if (leftover && unknownBits) {
      const k = "0x" + (leftover >>> 0).toString(16);
      unknownBits.set(k, (unknownBits.get(k) || 0) + 1);
    }
    const frame = FRAME_ORDER.find(f => frames.includes(f)) || "effect";

    const isLink = !!(typeValue & 0x4000000);
    const isMonster = !!(typeValue & 0x1);
    const levelValue = row.level || 0;

    const card = {
      id: row.id,
      name: row.name,
      text: body,
      types: labels,
      frame,
      source,
    };
    if (parsed.number) { card.number = parsed.number; card.seq = parsed.seq; card.packCode = parsed.code; }
    if (parsed.packName) card.packName = parsed.packName;
    if (parsed.credits.length) card.credits = parsed.credits;
    if (Object.keys(parsed.labels).length) card.labels = parsed.labels;
    if (row.alias) card.alias = row.alias;

    if (isMonster) {
      card.atk = row.atk;
      card.attribute = one(row.attribute, ATTRIBUTES);
      card.race = one(row.race, RACES);
      if (isLink) {
        card.link = levelValue & 0xFF;
        card.markers = bits(row.def || 0, LINK_MARKERS);
      } else {
        card.def = row.def;
        card.level = levelValue & 0xFF;
        const lscale = (levelValue >>> 24) & 0xFF;
        const rscale = (levelValue >>> 16) & 0xFF;
        if (lscale || rscale) card.scale = [lscale, rscale];
      }
    }
    return card;
  }

  /* 전체 행 묶음을 카드/팩/문제점으로 정리한다 */
  function buildAll(rows, options) {
    const opts = options || {};
    const extraTypes = opts.extraTypes || {};
    const packMeta = opts.packMeta || {};
    const aliases = (packMeta._aliases) || {};
    const warnings = [];
    const unknownBits = new Map();

    const customBits = [];
    for (const [key, raw] of Object.entries(extraTypes)) {
      if (key.startsWith("_")) continue;
      const spec = typeof raw === "string" ? { name: raw } : (raw || {});
      const name = String(spec.name || "").trim();
      if (!name) continue;
      customBits.push([parseInt(key, 16) >>> 0, { name, frame: spec.frame || null }]);
    }

    const seen = new Map();
    for (const r of rows) {
      if (seen.has(r.id)) {
        warnings.push(`ID ${r.id} 가 ${seen.get(r.id)} 와 ${r.source} 양쪽에 있다`);
      } else {
        seen.set(r.id, r.source);
      }
    }

    const backs = new Map();
    for (const r of rows) {
      if ((r.type & TYPE_UNLOCKED) && r.alias) backs.set(r.alias, r);
    }

    const nameOf = new Map(rows.map(r => [r.id, r.name]));

    /* 같은 그림 묶음 */
    const family = new Map();
    for (const r of rows) {
      if (r.type & TYPE_UNLOCKED) continue;
      let base = r.alias || r.id;
      if (r.alias && Math.abs(r.id - r.alias) > ART_SPAN) base = r.id;
      if (!family.has(base)) family.set(base, []);
      family.get(base).push(r.id);
    }
    const artsOf = new Map();
    for (const ids of family.values()) {
      if (ids.length < 2) continue;
      const ordered = ids.slice().sort((a, b) => a - b);
      for (const i of ordered) artsOf.set(i, ordered);
    }

    const allCards = [];
    const packs = new Map();

    for (const r of rows) {
      if (r.type & TYPE_UNLOCKED) continue;
      const card = describe(r, r.source, customBits, unknownBits);

      const back = backs.get(r.id);
      if (back) {
        card.back = describe(back, back.source, customBits, null);
        delete card.back.alias;
      }
      else if (r.type & TYPE_KEY) warnings.push(`키 카드 ${r.name} 의 해방면을 찾지 못했다`);

      const group = artsOf.get(r.id);
      if (group) card.arts = group.map(i => ({ id: i, name: nameOf.get(i) || "" }));

      allCards.push(card);

      if (card.packCode) {
        const code = aliases[card.packCode] || card.packCode;
        if (code !== card.packCode)
          warnings.push(`${r.name} 의 번호 ${card.number} 를 ${code} 로 보정했다`);
        if (!packs.has(code)) packs.set(code, []);
        packs.get(code).push(card);
      }
    }

    allCards.sort((a, b) => {
      const an = a.number || "zzz", bn = b.number || "zzz";
      return an === bn ? a.id - b.id : (an < bn ? -1 : 1);
    });

    const packIndex = [];
    for (const [code, cards] of packs) {
      cards.sort((a, b) => a.seq - b.seq);
      const info = packMeta[code] || {};
      const names = new Map();
      for (const c of cards) if (c.packName) names.set(c.packName, (names.get(c.packName) || 0) + 1);
      let best = code, bestN = 0;
      for (const [n, cnt] of names) if (cnt > bestN) { best = n; bestN = cnt; }
      packIndex.push({
        code,
        name: info.name || best,
        released: info.released || null,
        count: cards.length,
        cards,
      });
    }
    packIndex.sort((a, b) => {
      const ar = a.released || "9999", br = b.released || "9999";
      return ar === br ? (a.code < b.code ? -1 : 1) : (ar < br ? -1 : 1);
    });

    if (unknownBits.size) {
      const parts = [...unknownBits].map(([b, n]) => `${b} (${n}장)`).join(", ");
      warnings.push("정의되지 않은 타입 비트: " + parts);
    }

    return { allCards, packs: packIndex, warnings, usedIds: [...seen.keys()].sort((a, b) => a - b), nameOf, rows };
  }

  /* 할당표를 실제 카드와 대조 */
  function reconcile(allocSrc, rows, nameOf, usedIds) {
    const src = allocSrc || {};
    const issues = [];
    const ranges = (src.ranges || []).map(r => {
      const lo = Number(r.from), hi = Number(r.to);
      const inside = usedIds.filter(i => i >= lo && i <= hi);
      const taken = new Set(inside);
      let nextFree = null;
      for (let i = lo; i <= hi; i++) if (!taken.has(i)) { nextFree = i; break; }
      return {
        from: lo, to: hi, size: hi - lo + 1,
        owner: r.owner || "",
        purpose: r.purpose || r.archetype || "",
        note: r.note || "",
        status: r.status || "active",
        used: inside.length,
        next_free: nextFree,
        cards: inside.map(i => ({ id: i, name: nameOf.get(i) || "" })),
      };
    }).sort((a, b) => a.from - b.from);

    for (let i = 0; i + 1 < ranges.length; i++) {
      const a = ranges[i], b = ranges[i + 1];
      if (b.from <= a.to)
        issues.push({ kind: "overlap",
          detail: `${a.from}–${a.to} (${a.owner || "미배정"}) 과 ${b.from}–${b.to} (${b.owner || "미배정"}) 이 겹친다` });
    }

    const inAny = i => ranges.some(r => i >= r.from && i <= r.to);
    const orphans = usedIds.filter(i => !inAny(i));
    orphans.slice(0, 50).forEach(i =>
      issues.push({ kind: "orphan", detail: `${i} (${nameOf.get(i) || "?"}) 가 예약 구간 밖에서 쓰이고 있다` }));
    if (orphans.length > 50)
      issues.push({ kind: "orphan", detail: `… 예약 구간 밖 ID 가 ${orphans.length - 50}개 더 있다` });

    const usedCodes = new Map();
    const codeCards = new Map();
    for (const r of rows) {
      let packed = r.setcode || 0;
      for (let slot = 0; slot < 4; slot++) {
        const part = Number((BigInt(packed) >> BigInt(slot * 16)) & 0xFFFFn);
        if (!part) continue;
        usedCodes.set(part, (usedCodes.get(part) || 0) + 1);
        if (!codeCards.has(part)) codeCards.set(part, []);
        if (codeCards.get(part).length < 40) codeCards.get(part).push({ id: r.id, name: r.name });
      }
    }

    const seenCodes = new Map();
    const setcodes = [];
    for (const sc of (src.setcodes || [])) {
      const raw = String(sc.code || "").trim();
      const value = /^0x/i.test(raw) ? parseInt(raw, 16) : Number(raw);
      if (!Number.isFinite(value)) {
        issues.push({ kind: "setcode", detail: `카드군 코드 '${raw}' 를 숫자로 읽을 수 없다` });
        continue;
      }
      const base = value & 0xFFF;
      if (base <= 0x208)
        issues.push({ kind: "setcode", detail: `${raw} (${sc.name || ""}) 는 공식 카드군 대역(0x208 이하)이다` });
      if (seenCodes.has(base))
        issues.push({ kind: "setcode", detail: `${raw} 가 '${seenCodes.get(base)}' 와 '${sc.name || ""}' 에 중복 할당됐다` });
      else seenCodes.set(base, sc.name || "");
      setcodes.push({
        code: raw, value, name: sc.name || "", owner: sc.owner || "", note: sc.note || "",
        used: usedCodes.get(value) || 0,
        cards: codeCards.get(value) || [],
      });
    }
    setcodes.sort((a, b) => a.value - b.value);

    const declared = new Set(setcodes.map(s => s.value));
    for (const [val, n] of [...usedCodes].sort((a, b) => a[0] - b[0])) {
      if (declared.has(val)) continue;
      const sample = (codeCards.get(val) || []).slice(0, 3).map(c => c.name).join(", ");
      issues.push({ kind: "setcode",
        detail: `0x${val.toString(16)} 가 카드 ${n}장에 쓰이고 있는데 카드군 목록에 없다` + (sample ? ` (${sample})` : "") });
    }

    return { ranges, setcodes, issues, used_total: usedIds.length };
  }

  /* 엔진 헤더에서 상수표를 만든다 */
  function parseConstants(headerText, luaText, customBitKeys) {
    const define = /^#define\s+([A-Z][A-Z0-9_]*)\s+(.+?)\s*$/;
    const groups = new Map();
    for (const line of String(headerText || "").split("\n")) {
      const m = define.exec(line.replace(/\s+$/, ""));
      if (!m) continue;
      let name = m[1], rest = m[2], note = null;
      const ci = rest.indexOf("//");
      if (ci >= 0) { note = rest.slice(ci + 2).trim(); rest = rest.slice(0, ci).trim(); }
      rest = rest.trim();
      if (!rest) continue;
      const prefix = name.split("_")[0];
      if (!groups.has(prefix)) groups.set(prefix, []);
      const entry = { name, value: rest };
      if (note) entry.note = note;
      groups.get(prefix).push(entry);
    }

    const out = {
      source: headerText ? "gframe/ocgapi_constants.h" : null,
      groups: [...groups].map(([prefix, entries]) => ({ prefix, entries })),
      drift: [],
      custom: [],
    };

    // C 상수 표기를 읽는다. 0x.. 는 16진수, 0 으로 시작하면 8진수(링크 마커가 그렇다).
    const num = s => {
      const t = String(s).trim();
      let v;
      if (/^0x[0-9a-f]+$/i.test(t)) v = parseInt(t, 16);
      else if (/^0[0-7]+$/.test(t)) v = parseInt(t, 8);
      else if (/^\d+$/.test(t)) v = Number(t);
      else return null;
      return Number.isFinite(v) ? v : null;
    };

    const engineVals = new Map();
    const engineByValue = new Map();
    for (const g of out.groups) {
      for (const e of g.entries) {
        const v = num(e.value);
        if (v === null) continue;
        engineVals.set(e.name, v);
        const k = g.prefix + ":" + v;
        if (!engineByValue.has(k)) engineByValue.set(k, e.name);
      }
    }

    const wanted = new Set((customBitKeys || []).map(k => parseInt(k, 16)));
    for (const g of out.groups) {
      if (g.prefix !== "TYPE") continue;
      for (const e of g.entries) {
        const v = num(e.value);
        if (v !== null && wanted.has(v)) out.custom.push(e.name);
      }
    }

    if (luaText) {
      const assign = /^([A-Z][A-Z0-9_]*)\s*=\s*(0x[0-9a-fA-F]+|\d+)/;
      const luaVals = new Map();
      for (const line of luaText.split("\n")) {
        const m = assign.exec(line.trim());
        if (m) luaVals.set(m[1], num(m[2]));
      }
      for (const [name, lval] of luaVals) {
        const ev = engineVals.get(name);
        if (ev !== undefined && ev !== lval)
          out.drift.push({ kind: "value", name, engine: "0x" + ev.toString(16), lua: "0x" + lval.toString(16) });
      }
      for (const prefix of ["TYPE", "RACE", "ATTRIBUTE"]) {
        for (const [name, lval] of luaVals) {
          if (!name.startsWith(prefix + "_")) continue;
          const ename = engineByValue.get(prefix + ":" + lval);
          if (ename && ename !== name && !engineVals.has(name))
            out.drift.push({ kind: "name", value: "0x" + lval.toString(16), engine: ename, lua: name });
        }
      }
    }
    return out;
  }

  global.OricaDecode = {
    buildAll, reconcile, parseConstants, describe, splitDesc, parseMeta,
    TYPE_UNLOCKED, TYPE_KEY, ART_SPAN,
  };
})(typeof window !== "undefined" ? window : globalThis);
