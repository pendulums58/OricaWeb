#!/usr/bin/env python3
"""CyanPro Card Database — 이미지 빌드.

카드 해석은 브라우저가 template/decode.js 로 직접 한다. 이 스크립트는
사이트 파일을 dist/ 에 모으고, 원본 이미지를 가벼운 webp 로 줄이는 일만 맡는다.

webp 가 아직 없는 새 카드는 사이트가 원본 이미지를 직접 불러오므로,
이 빌드가 늦어도 카드가 안 보이는 일은 없다.
"""
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")

# 사이트를 이루는 파일들. 브라우저가 이것들을 그대로 읽는다.
SITE_FILES = [
    "config.json",
    "types.extra.json",
    "packs.meta.json",
    "allocations.json",
]

ICON_SLOTS = [
    "attr-earth", "attr-water", "attr-fire", "attr-wind",
    "attr-light", "attr-dark", "attr-divine", "level", "rank", "link",
]

THUMB_WIDTH = 300


def find_pack_dir():
    """카드 리포(CyanPro_CardDB)의 위치를 찾는다."""
    env = os.environ.get("ORICA_PACK_DIR")
    for path in ([env] if env else []) + [
            os.path.join(HERE, "packs"),
            os.path.join(os.path.dirname(HERE), "CyanPro_CardDB")]:
        if path and os.path.isdir(path):
            return os.path.abspath(path)
    return None


def main():
    os.makedirs(os.path.join(DIST, "data"), exist_ok=True)
    os.makedirs(os.path.join(DIST, "img"), exist_ok=True)
    warnings = []

    # ---- 사이트 파일 ----
    shutil.copy2(os.path.join(HERE, "template", "index.html"),
                 os.path.join(DIST, "index.html"))
    shutil.copy2(os.path.join(HERE, "template", "decode.js"),
                 os.path.join(DIST, "decode.js"))
    for name in SITE_FILES:
        src = os.path.join(HERE, name)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(DIST, name))
        else:
            warnings.append(f"{name} 이 없다")

    # ---- 선택 아이콘 ----
    icons = {}
    icon_src = os.path.join(HERE, "icons")
    if os.path.isdir(icon_src):
        out_dir = os.path.join(DIST, "icons")
        os.makedirs(out_dir, exist_ok=True)
        for slot in ICON_SLOTS:
            for ext in (".png", ".webp", ".svg", ".jpg", ".jpeg"):
                cand = os.path.join(icon_src, slot + ext)
                if os.path.exists(cand):
                    shutil.copy2(cand, os.path.join(out_dir, slot + ext))
                    icons[slot] = f"icons/{slot}{ext}"
                    break
    with open(os.path.join(DIST, "data", "icons.json"), "w", encoding="utf-8") as fh:
        json.dump(icons, fh, ensure_ascii=False, indent=1)

    # ---- cdb 목록 (GitHub API 가 막혔을 때의 대비책) ----
    root = find_pack_dir()
    cdbs = []
    if root:
        for dirpath, _dirs, names in os.walk(root):
            if ".git" in dirpath.split(os.sep):
                continue
            for n in names:
                if n.lower().endswith(".cdb"):
                    rel = os.path.relpath(os.path.join(dirpath, n), root)
                    cdbs.append(rel.replace(os.sep, "/"))
    cdbs.sort()
    with open(os.path.join(DIST, "data", "cdbs.json"), "w", encoding="utf-8") as fh:
        json.dump(cdbs, fh, ensure_ascii=False, indent=1)

    # ---- 이미지 ----
    made = []
    if not root:
        warnings.append("카드 리포를 찾지 못해 이미지를 만들지 않았다")
    else:
        pics = os.path.join(root, "pics")
        if not os.path.isdir(pics):
            warnings.append("pics 폴더가 없다")
        else:
            try:
                from PIL import Image
            except ImportError:
                Image = None
                warnings.append("Pillow 가 없어 이미지를 만들지 않았다")

            if Image is not None:
                for name in sorted(os.listdir(pics)):
                    stem, ext = os.path.splitext(name)
                    if ext.lower() not in (".jpg", ".jpeg", ".png", ".webp"):
                        continue
                    if not stem.isdigit():
                        continue
                    out = os.path.join(DIST, "img", f"{stem}.webp")
                    try:
                        with Image.open(os.path.join(pics, name)) as im:
                            im = im.convert("RGB")
                            height = round(im.height * THUMB_WIDTH / im.width)
                            im.resize((THUMB_WIDTH, height),
                                      Image.LANCZOS).save(out, "WEBP", quality=82)
                        made.append(int(stem))
                    except Exception as err:
                        warnings.append(f"{name} 변환 실패: {err}")

    made.sort()
    with open(os.path.join(DIST, "data", "webp.json"), "w", encoding="utf-8") as fh:
        json.dump(made, fh)

    report = {"images": len(made), "icons": len(icons),
              "cdbs": len(cdbs), "warnings": warnings}
    with open(os.path.join(DIST, "report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)

    print(f"이미지 {len(made)}장 · 아이콘 {len(icons)}개 · cdb 목록 {len(cdbs)}개")
    for w in warnings:
        print("  경고:", w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
