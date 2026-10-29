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
| `allocations.json` | ID 구간·카드군 코드 할당표. 스크립터 배정을 여기서 관리한다 |
| `template/index.html` | 사이트 본체 |
| `icons/` | 속성·레벨 아이콘을 넣어두면 내장 SVG 대신 쓴다 (선택) |

## 화면

| 탭 | 내용 |
| --- | --- |
| 전체 카드 목록 | 카드 리포의 모든 카드. 팩에 수록되지 않은 카드도 나온다 |
| 팩 목록 | 번호로 묶인 팩들 |
| 코드 일람 | CyanCore 엔진 헤더에서 뽑은 상수표. `constant.lua` 와 어긋나는 값은 따로 경고한다 |
| 할당 현황 | ID 구간과 카드군 코드를 누가 쓰는지. 실제 cdb 와 맞춰 사용량·다음 빈 번호를 계산한다 |

## 할당표

`allocations.json` 을 고치고 커밋하면 사이트에 반영된다. 쓰기 권한이 있는 사람만 고칠 수 있으므로,
별도의 계정 시스템 없이 GitHub 협업자 설정이 그대로 권한이 된다.

**ID 구간과 카드군 코드는 서로 묶이지 않는다.** 한 구간에 여러 카드군이 섞일 수도 있고,
한 카드군이 여러 구간에 걸칠 수도 있어서 둘을 각각 관리한다.

| 표 | 무엇을 막는가 | 실제와 대조하는 것 |
| --- | --- | --- |
| ID 구간 | 카드 번호 충돌 | cdb 에 실제로 있는 카드 ID |
| 카드군 코드 | setcode 충돌 | cdb 의 `datas.setcode` (16비트씩 최대 4개) |

빌드가 잡아내는 것.

- 예약 구간끼리 겹침
- 어느 구간에도 속하지 않는 ID 가 쓰이고 있음
- 카드군 코드 중복
- 공식 카드군 대역(`0x208` 이하) 침범
- 목록에 없는 setcode 가 카드에 박혀 있음

오리카 카드군은 `0x300` 부터 쓴다. 공식 카드군이 `0x208` 까지 차 있어 그 위는 전부 비어 있다.

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

코드 일람은 엔진 리포(CyanPro)의 `gframe/ocgapi_constants.h` 를 읽는다.
`../CyanPro` 에 있으면 자동으로 찾고, 없으면 코드 일람 탭만 비어 있다.

```
ORICA_ENGINE_DIR=/path/to/CyanPro python build.py
```

## 배포

`main` 에 push 할 때, 그리고 6시간마다 자동으로 다시 빌드한다.
카드 리포에만 카드를 추가해도 다음 주기에 반영된다.
바로 반영하려면 Actions 탭에서 워크플로를 직접 실행한다.
