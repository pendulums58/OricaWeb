# OricaWeb

[CyanPro_CardDB](https://github.com/pendulums58/CyanPro_CardDB) 카드 리포를 읽어 팩 목록 웹사이트를 만든다.

카드 리포는 CyanPro 사용자가 그대로 받아 쓰는 곳이라 건드리지 않는다.
이 리포가 빌드할 때 카드 리포를 클론해서 읽기만 한다.

## 구조

| 파일 | 역할 |
| --- | --- |
| `build.py` | cdb 스캔 → `dist/` 에 JSON + webp 생성. 표준 라이브러리만 사용 |
| `types.extra.json` | CyanCore 오리지널 타입 비트 → 표시 이름 |
| `packs.meta.json` | 팩 표시 이름·발매일, 팩 코드 오타 보정 |
| `template/index.html` | 사이트 본체 |

## 팩의 기준

효과 설명 맨 끝의 `[POG1-AM001]` 번호로 묶는다. 번호가 없는 카드는
아직 팩으로 묶이지 않은 것으로 보고 사이트에 넣지 않는다.

## 로컬에서 빌드

CyanPro_CardDB 를 이 리포와 나란히 두면 알아서 찾는다.

```
python build.py
cd dist && python -m http.server 8000
```

다른 곳에 있으면 경로를 지정한다.

```
ORICA_PACK_DIR=/path/to/CyanPro_CardDB python build.py
```

## 배포

`main` 에 push 할 때, 그리고 6시간마다 자동으로 다시 빌드한다.
카드 리포에만 카드를 추가해도 다음 주기에 반영된다.
바로 반영하려면 Actions 탭에서 워크플로를 직접 실행한다.
