#!/usr/bin/env python3
"""AMCTOrica 팩 데이터 빌드.

리포 루트의 *.cdb 를 전부 읽어, 효과 설명 끝의 [CODE-AM001] 번호가 있는
카드만 모아 팩 단위 JSON과 이미지를 web/dist 에 만든다.

표준 라이브러리만 사용한다. Pillow 가 있으면 이미지를 webp 로 줄이고,
없으면 원본을 그대로 복사한다.
"""
import collections
import json
import os
import re
import shutil
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")


def find_pack_dir():
    """카드 리포(AMCTOrica)의 위치를 찾는다.

    ORICA_PACK_DIR 환경변수 > ./packs (CI 가 클론하는 자리) >
    ../AMCTOrica (리포를 나란히 두고 쓰는 로컬 작업) 순으로 본다.
    """
    env = os.environ.get("ORICA_PACK_DIR")
    candidates = [env] if env else []
    candidates.append(os.path.join(HERE, "packs"))
    candidates.append(os.path.join(os.path.dirname(HERE), "AMCTOrica"))
    for path in candidates:
        if path and os.path.isdir(path) and any(
                f.lower().endswith(".cdb") for f in os.listdir(path)):
            return os.path.abspath(path)
    sys.exit(
        "카드 리포를 찾지 못했다. AMCTOrica 를 이 리포 옆에 두거나,\n"
        "ORICA_PACK_DIR 환경변수로 경로를 지정해라.")


ROOT = find_pack_dir()
PICS = os.path.join(ROOT, "pics")

# ---------------------------------------------------------------- 상수

NUMBER = re.compile(r"^\[([A-Z0-9]{3,6})-([A-Z]{2})(\d{3})\]$")
LABELLED = re.compile(r"^\[\s*([^\[\]:：]+?)\s*[:：]\s*(.*?)\s*\]$")
PLAIN = re.compile(r"^\[\s*([^\[\]]+?)\s*\]$")

TYPE_BITS = [
    (0x1, "몬스터"), (0x2, "마법"), (0x4, "함정"),
    (0x10, "일반"), (0x20, "효과"), (0x40, "융합"), (0x80, "의식"),
    (0x100, "함정 몬스터"), (0x200, "스피릿"), (0x400, "유니온"),
    (0x800, "듀얼"), (0x1000, "튜너"), (0x2000, "싱크로"), (0x4000, "토큰"),
    (0x10000, "속공"), (0x20000, "지속"), (0x40000, "장착"), (0x80000, "필드"),
    (0x100000, "카운터"), (0x200000, "리버스"), (0x400000, "툰"),
    (0x800000, "엑시즈"), (0x1000000, "펜듈럼"), (0x2000000, "특수 소환"),
    (0x4000000, "링크"),
]
KNOWN_TYPE_MASK = 0
for _b, _l in TYPE_BITS:
    KNOWN_TYPE_MASK |= _b

ATTRIBUTES = [(0x1, "땅"), (0x2, "물"), (0x4, "불"), (0x8, "바람"),
              (0x10, "빛"), (0x20, "어둠"), (0x40, "신")]

RACES = [
    (0x1, "전사족"), (0x2, "마법사족"), (0x4, "천사족"), (0x8, "악마족"),
    (0x10, "언데드족"), (0x20, "기계족"), (0x40, "물족"), (0x80, "염족"),
    (0x100, "암석족"), (0x200, "조인족"), (0x400, "식물족"), (0x800, "곤충족"),
    (0x1000, "번개족"), (0x2000, "드래곤족"), (0x4000, "야수족"),
    (0x8000, "야수전사족"), (0x10000, "공룡족"), (0x20000, "어류족"),
    (0x40000, "해룡족"), (0x80000, "파충류족"), (0x100000, "사이킥족"),
    (0x200000, "환신야수족"), (0x400000, "창조신족"), (0x800000, "환룡족"),
    (0x1000000, "사이버스족"),
]

LINK_MARKERS = [(0x1, "↙"), (0x2, "↓"), (0x4, "↘"), (0x8, "←"),
                (0x20, "→"), (0x40, "↖"), (0x80, "↑"), (0x100, "↗")]


def bits(value, table):
    return [label for bit, label in table if value & bit]


def one(value, table):
    for bit, label in table:
        if value & bit:
            return label
    return None


# ---------------------------------------------------------------- 설명 파싱

def split_desc(desc):
    """효과 설명을 본문과 꼬리의 대괄호 메타 줄로 나눈다."""
    text = (desc or "").replace("\r\n", "\n").replace("\r", "\n").rstrip()
    lines = text.split("\n")
    meta = []
    while lines:
        last = lines[-1].strip()
        if last == "":
            lines.pop()
            continue
        if last.startswith("[") and last.endswith("]"):
            meta.insert(0, last)
            lines.pop()
            continue
        break
    return "\n".join(lines).strip(), meta


def parse_meta(meta_lines):
    out = {"number": None, "code": None, "seq": None, "region": None,
           "pack_name": None, "credits": [], "labels": {}}
    for line in meta_lines:
        m = NUMBER.match(line)
        if m:
            out["code"], out["region"], out["seq"] = m.group(1), m.group(2), int(m.group(3))
            out["number"] = f"{m.group(1)}-{m.group(2)}{m.group(3)}"
            continue
        m = LABELLED.match(line)
        if m:
            key = re.sub(r"\s+", " ", m.group(1)).strip()
            out["labels"].setdefault(key, []).append(m.group(2))
            continue
        m = PLAIN.match(line)
        if m:
            inner = m.group(1).strip()
            # "이피 / YiPi", "시안색새벽 / 범용" 처럼 슬래시가 든 줄은 제작자 표기로 본다
            if "/" in inner:
                out["credits"].append(inner)
            else:
                out["pack_name"] = inner
    return out


# ---------------------------------------------------------------- 메인

def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main():
    extra_types = load_json(os.path.join(HERE, "types.extra.json"), {})
    meta_file = os.path.join(HERE, "packs.meta.json")
    pack_meta = load_json(meta_file, {})
    aliases = pack_meta.get("_aliases", {})

    custom_bits = {}
    for key, label in extra_types.items():
        if key.startswith("_") or not str(label).strip():
            continue
        custom_bits[int(key, 16)] = str(label).strip()

    cdbs = sorted(f for f in os.listdir(ROOT) if f.lower().endswith(".cdb"))
    warnings = []
    unknown_bits = collections.Counter()
    seen_ids = {}

    TYPE_UNLOCKED = 0x8000
    TYPE_KEY = 0x8

    # --- 1패스: 모든 cdb 의 모든 행을 읽는다 (뒷면은 번호가 없을 수 있다) ---
    records = []
    for fname in cdbs:
        path = os.path.join(ROOT, fname)
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        try:
            rows = con.execute(
                "select t.id, t.name, t.desc, d.ot, d.alias, d.setcode, d.type,"
                " d.atk, d.def, d.level, d.race, d.attribute"
                " from texts t join datas d on d.id = t.id").fetchall()
        except sqlite3.Error as err:
            warnings.append(f"{fname}: 읽기 실패 — {err}")
            continue
        finally:
            con.close()
        for row in rows:
            if row["id"] in seen_ids:
                warnings.append(
                    f"ID {row['id']} 가 {seen_ids[row['id']]} 와 {fname} 양쪽에 있다")
            else:
                seen_ids[row["id"]] = fname
            records.append((fname, row))

<<<<<<< Updated upstream
            type_value = row["type"]
            leftover = type_value & ~KNOWN_TYPE_MASK
            labels = bits(type_value, TYPE_BITS)
            for bit, label in custom_bits.items():
                if leftover & bit:
                    labels.append(label)
                    leftover &= ~bit
            if leftover:
                unknown_bits[hex(leftover)] += 1
=======
    # 해방면(UNLOCKED)은 alias 로 앞면을 가리킨다
    backs = {}
    for fname, row in records:
        if row["type"] & TYPE_UNLOCKED and row["alias"]:
            backs[row["alias"]] = (fname, row)
>>>>>>> Stashed changes

    def describe(fname, row, meta):
        """한 행을 카드 dict 로 만든다."""
        type_value = row["type"]
        leftover = type_value & ~KNOWN_TYPE_MASK
        labels = bits(type_value, TYPE_BITS)
        frames = [r[2] for r in TYPE_BITS if type_value & r[0] and r[2]]
        for bit, spec in custom_bits.items():
            if leftover & bit:
                labels.append(spec["name"])
                if spec.get("frame"):
                    frames.append(spec["frame"])
                leftover &= ~bit
        if leftover:
            unknown_bits[hex(leftover)] += 1
        frame = next((f for f in FRAME_ORDER if f in frames), "effect")

<<<<<<< Updated upstream
            card = {
                "id": row["id"],
                "name": row["name"],
                "number": meta["number"],
                "seq": meta["seq"],
                "text": body,
                "types": labels,
                "source": fname,
            }
            if meta["pack_name"]:
                card["_packname"] = meta["pack_name"]
            if meta["credits"]:
                card["credits"] = meta["credits"]
            if meta["labels"]:
                card["labels"] = {k: v for k, v in meta["labels"].items()}
            if row["alias"]:
                card["alias"] = row["alias"]
            if is_monster:
                card["atk"] = row["atk"]
                card["attribute"] = one(row["attribute"], ATTRIBUTES)
                card["race"] = one(row["race"], RACES)
                if is_link:
                    card["link"] = level_value & 0xFF
                    card["markers"] = bits(row["def"] or 0, LINK_MARKERS)
                else:
                    card["def"] = row["def"]
                    card["level"] = level_value & 0xFF
                    lscale = (level_value >> 24) & 0xFF
                    rscale = (level_value >> 16) & 0xFF
                    if lscale or rscale:
                        card["scale"] = [lscale, rscale]
            packs[code].append(card)
=======
        is_link = bool(type_value & 0x4000000)
        is_monster = bool(type_value & 0x1)
        level_value = row["level"] or 0

        card = {
            "id": row["id"],
            "name": row["name"],
            "text": meta["body"],
            "types": labels,
            "frame": frame,
            "source": fname,
        }
        if meta.get("number"):
            card["number"] = meta["number"]
            card["seq"] = meta["seq"]
        if meta["credits"]:
            card["credits"] = meta["credits"]
        if meta["labels"]:
            card["labels"] = dict(meta["labels"])
        if is_monster:
            card["atk"] = row["atk"]
            card["attribute"] = one(row["attribute"], ATTRIBUTES)
            card["race"] = one(row["race"], RACES)
            if is_link:
                card["link"] = level_value & 0xFF
                card["markers"] = bits(row["def"] or 0, LINK_MARKERS)
            else:
                card["def"] = row["def"]
                card["level"] = level_value & 0xFF
                lscale = (level_value >> 24) & 0xFF
                rscale = (level_value >> 16) & 0xFF
                if lscale or rscale:
                    card["scale"] = [lscale, rscale]
        return card

    # --- 2패스: 번호가 있는 앞면만 팩에 넣는다 ---
    packs = collections.defaultdict(list)
    skipped = 0
    for fname, row in records:
        if row["type"] & TYPE_UNLOCKED:
            continue  # 해방면은 앞면에 붙여서 내보낸다
        body, meta_lines = split_desc(row["desc"])
        meta = parse_meta(meta_lines)
        meta["body"] = body
        if not meta["number"]:
            skipped += 1
            continue

        code = aliases.get(meta["code"], meta["code"])
        if code != meta["code"]:
            warnings.append(
                f"{fname}: {row['name']} 의 번호 {meta['number']} 를 {code} 로 보정했다")

        card = describe(fname, row, meta)
        if meta["pack_name"]:
            card["_packname"] = meta["pack_name"]
        if row["alias"]:
            card["alias"] = row["alias"]

        back = backs.get(row["id"])
        if back:
            bfname, brow = back
            bbody, bmeta_lines = split_desc(brow["desc"])
            bmeta = parse_meta(bmeta_lines)
            bmeta["body"] = bbody
            card["back"] = describe(bfname, brow, bmeta)
        elif row["type"] & TYPE_KEY:
            warnings.append(f"{fname}: 키 카드 {row['name']} 의 해방면을 찾지 못했다")

        packs[code].append(card)
>>>>>>> Stashed changes

    # ---- 이미지 ----
    os.makedirs(os.path.join(DIST, "img"), exist_ok=True)
    try:
        from PIL import Image
        have_pil = True
    except ImportError:
        have_pil = False
        warnings.append("Pillow 가 없어 원본 이미지를 그대로 복사한다")

    copied = 0
    missing = []
    targets = []
    for cards in packs.values():
        for card in cards:
            targets.append(card)
            if card.get("back"):
                targets.append(card["back"])
    for card in targets:
        if True:
            src = None
            for ext in (".jpg", ".png", ".jpeg", ".webp"):
                candidate = os.path.join(PICS, f"{card['id']}{ext}")
                if os.path.exists(candidate):
                    src = candidate
                    break
            if not src:
                missing.append(card.get("number") or str(card["id"]))
                continue
            if have_pil:
                with Image.open(src) as im:
                    im = im.convert("RGB")
                    im.copy().resize(
                        (300, round(im.height * 300 / im.width)),
                        Image.LANCZOS).save(
                        os.path.join(DIST, "img", f"{card['id']}.webp"),
                        "WEBP", quality=82)
                card["img"] = f"img/{card['id']}.webp"
            else:
                shutil.copy2(src, os.path.join(DIST, "img", os.path.basename(src)))
                card["img"] = f"img/{os.path.basename(src)}"
            copied += 1
    if missing:
        warnings.append(f"이미지 없는 카드 {len(missing)}장: {', '.join(missing[:10])}")

    # ---- 팩 목록 ----
    os.makedirs(os.path.join(DIST, "data"), exist_ok=True)
    index = []
    for code, cards in packs.items():
        cards.sort(key=lambda c: c["seq"])
        info = pack_meta.get(code, {})
        names = collections.Counter(
            c.pop("_packname") for c in cards if c.get("_packname"))
        name = info.get("name") or (names.most_common(1)[0][0] if names else code)
        released = info.get("released")
        if not released:
            warnings.append(f"{code}: 발매일이 packs.meta.json 에 없다")
        entry = {
            "code": code,
            "name": name,
            "released": released,
            "count": len(cards),
            "cover": cards[0].get("img") if cards else None,
        }
        index.append(entry)
        with open(os.path.join(DIST, "data", f"pack-{code}.json"), "w",
                  encoding="utf-8") as fh:
            json.dump({**entry, "cards": cards}, fh, ensure_ascii=False, indent=1)

    index.sort(key=lambda p: (p["released"] or "9999", p["code"]))
    with open(os.path.join(DIST, "data", "packs.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=1)

    shutil.copy2(os.path.join(HERE, "template", "index.html"),
                 os.path.join(DIST, "index.html"))

    # ---- 보고 ----
    if unknown_bits:
        warnings.append("정의되지 않은 타입 비트: " + ", ".join(
            f"{b} ({n}장)" for b, n in unknown_bits.most_common()))
    report = {
        "packs": len(index),
        "cards": sum(p["count"] for p in index),
        "images": copied,
        "skipped_no_number": skipped,
        "warnings": warnings,
    }
    with open(os.path.join(DIST, "report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)

    print(f"팩 {report['packs']}개 · 카드 {report['cards']}장 · 이미지 {copied}장")
    print(f"번호 없어 제외한 카드 {skipped}장")
    for w in warnings:
        print("  경고:", w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
