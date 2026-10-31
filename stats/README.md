# 듀얼 통계 수집기

CyanPro 호스트가 듀얼이 끝날 때 결과를 보내고, 사이트가 그걸 읽어 카드별
채용률과 승률을 보여준다.

```
CyanPro 호스트 ──POST /duels──> Cloudflare Worker ──> D1
사이트 ─────────GET /stats/cards─────────┘
```

## 왜 호스트만 보내는가

듀얼이 끝날 때 **양쪽 덱을 전부 아는 건 호스트뿐**이다. 클라이언트는 자기 덱만
안다 (`duelclient.cpp` 가 아니라 `generic_duel.cpp` 에 훅을 거는 이유다).

그래서 **전용 서버 방은 집계되지 않는다.** 누군가 방을 파서 노는 구조에서만 쌓인다.

## 듀얼 ID

리플레이 시드(`Utils::GetRandomNumberGeneratorSeed()`, 256비트)를 그대로 쓴다.
듀얼마다 새로 생기므로 고유하고, 이미 존재하는 값이라 따로 만들 필요가 없다.
서버는 같은 ID 가 다시 오면 무시하므로 재전송해도 안전하다.

매치(2선승)는 듀얼마다 시드가 바뀌므로 **첫 듀얼의 시드를 `match_id`** 로 함께
보낸다. 듀얼 승률과 매치 승률을 따로 낼 수 있다.

## 무엇을 저장하는가

덱 전체를 카드 단위로 저장한다. 집계값만 두면 나중에 지표를 바꿀 때 과거
기록을 다시 계산할 수 없다.

| 테이블 | 내용 |
| --- | --- |
| `duels` | 듀얼 한 건. 승자, 포맷, 시각, 숨김 여부, 출처(`human`/`sim`) |
| `duel_players` | 자리별 플레이어와 승패, 덱 지문, 매치 내 고정 번호. **이름은 공개 통계에 나가지 않는다** |
| `deck_cards` | (듀얼, 자리, 존, 카드) 별 매수 |
| `card_usage` | 카드별 기회·선택 횟수. 시뮬레이션에서만 채워진다 |

무승부는 `winner = 2` 로 저장하고, 승률 분모에서 빠진다.

## 같은 덱을 하나로 세기

한 사람이 같은 덱으로 50판을 돌리면 그대로는 덱 50개로 센다. 그래서 두 가지
분모를 모두 낸다.

| 기준 | 분모 | 답하는 질문 |
| --- | --- | --- |
| 판수 | 듀얼마다의 덱 | 실제 대전에서 이 카드가 얼마나 나왔나 |
| 고유 덱 | 서로 다른 레시피 | 몇 가지 빌드가 이 카드를 넣나 |

작은 커뮤니티에서는 한 명이 갈면 판수 기준이 통째로 왜곡된다. 반대로 고유 덱만
보면 열 명이 같은 리스트를 돌려도 1로 깎여 환경 점유율을 놓친다. 둘 다 필요하다.

지문은 **메인 + 엑스트라** 구성에서만 뽑는다 (`duel_players.deck_hash`).
카드 순서는 무시하고 매수는 반영하므로, 같은 레시피면 같은 값이 나온다.

고유 덱 집계는 **`game_no = 1` 인 판만** 센다. 호스트가 보내는 덱은 사이드 교체가
끝난 상태라, 2선승 매치의 2·3차전을 그대로 세면 한 사람의 한 매치가 덱 세 개가
되어 버린다. 1차전이 사이드 교체 전 원본이다.

## 덱 레시피별 통계

`GET /stats/decks` 는 레시피마다 매치 승률과 듀얼 승률을 낸다.

**매치 1차전 덱을 그 매치의 정식 레시피로 보고, 2·3차전 결과까지 거기에 귀속시킨다.**
사이드 교체 때문에 2·3차전은 리스트가 달라 보이지만 같은 덱이다.

사람을 묶는 기준은 `seat` 이 아니라 `player_no` 다. 진 쪽이 선공을 고르면
`GenericDuel::TPResult()` 가 `players.home` 과 `players.opposing` 을 통째로 바꿔서
**자리가 매치 중간에 뒤집힌다.** `match_result` 도 같이 뒤집히므로 한 듀얼 안의
승자 판정은 정확하지만, 매치를 가로지를 때는 쓸 수 없다.

`player_no` 가 없는 기록은 이 집계에서 빠진다.

카드별 승률과 달리 이 숫자는 덱 전체의 성적이라, "강한 덱에 들어 있어서 강해
보이는" 교란이 없다.

## 사람 대전과 시뮬레이션

`source` 로 구분해 저장하고, 통계 조회의 기본값은 `human` 이다. 시뮬레이션이
사람 통계를 덮지 않으면서 같은 화면에서 나란히 비교할 수 있다.

```
GET /stats/cards?source=human   (기본)
GET /stats/cards?source=sim
GET /stats/cards?source=all
```

시뮬레이션은 `card_usage` 에 **엔진이 합법적 선택지로 제시한 횟수(`offered`)와
AI 가 실제로 고른 횟수(`taken`)** 를 보낸다.

드로우를 분모로 쓰면 안 된다. 현대 유희왕은 서치·덤핑·덱 특수소환으로 꺼내
쓰는 비율이 훨씬 높아 드로우는 접근 경로의 일부일 뿐이고, 명칭 턴 제한 때문에
발동 횟수 자체에도 변별력이 없다.

```
offered 0                → 기회가 없었음 (루트 미성립 / 서치 실패)
offered 200 / taken   3  → AI 가 쓸 줄 모름. 그 카드 승률은 근거가 못 됨
offered 200 / taken 190  → 이해함. 승률 참고 가능
```

`offered 0` 이 따로 보이는 게 중요하다. "안 쓴 것" 과 "쓸 기회가 없던 것" 은
원인이 다르다 — 전자는 AI 로직, 후자는 서치 루트나 덱 구성 문제다.

전개 루트로 엮인 카드들은 선택률이 서로 같게 나온다. 어느 파츠가 중요한지는
이 지표로 알 수 없고, **그 카드를 빼고 같은 덱을 돌리는 A/B** 로만 답할 수 있다.

판수를 늘리면 분산은 줄지만 편향은 그대로다. AI 가 못 쓰는 카드는 1만 판을
돌려도 계속 약하게 나오고, 신뢰구간만 좁아져 틀린 숫자에 확신이 붙는다.
선택률은 그걸 가려내기 위한 장치다.

보내는 형식은 이렇다.

```json
{
  "source": "sim",
  "players": [
    { "seat": 0, "deck": { "main": [...], "extra": [...] },
      "usage": [ { "card_id": 130000000, "offered": 40, "taken": 38 } ] }
  ]
}
```

## 들어오는 보고를 거르는 기준

열린 엔드포인트라 누구나 보낼 수 있다. 서버가 기계적으로 거르는 것은 이 정도다.

- 같은 `duel_id` 중복
- 메인 덱 40~60장, 엑스트라·사이드 15장 이하
- 카드 ID 가 양의 정수
- 본문 64KB 이하

나머지는 **관리 화면에서 직접 보고 숨긴다**. 숨긴 기록은 통계에서 빠지지만
지워지지는 않는다.

---

# 배포

Cloudflare 계정이 필요하다. 무료 한도로 충분하다 (하루 10만 요청, D1 5GB).

## 1. wrangler 준비

```bash
npm install -g wrangler
wrangler login
```

## 2. D1 데이터베이스 만들기

```bash
cd stats
wrangler d1 create cyanpro-stats
```

출력에 나오는 `database_id` 를 `wrangler.toml` 의 `database_id` 에 적는다.

## 3. 스키마 적용

```bash
wrangler d1 execute cyanpro-stats --remote --file=schema.sql
```

이미 전에 스키마를 적용했다면 추가분만 넣는다.

```bash
wrangler d1 execute cyanpro-stats --remote --file=migrations/001_source_and_usage.sql
```

001 까지 이미 실행했다면 002 도 실행한다 (드로우 분모 → 기회 분모).

```bash
wrangler d1 execute cyanpro-stats --remote --file=migrations/002_offered_taken.sql
```

덱 지문 컬럼을 추가한다 (스키마를 처음 만드는 경우에는 이미 포함돼 있다).

```bash
wrangler d1 execute cyanpro-stats --remote --file=migrations/003_deck_hash.sql
wrangler d1 execute cyanpro-stats --remote --file=migrations/004_player_no.sql
```

## 4. 관리자 토큰 설정

```bash
wrangler secret put ADMIN_TOKEN
```

아무 긴 문자열이나 넣는다. 이 토큰은 관리 화면에서만 쓰이고, 통계 읽기에는
필요 없다.

## 5. 배포

```bash
wrangler deploy
```

끝나면 `https://cyanpro-stats.<계정>.workers.dev` 같은 주소가 나온다.
그 주소를 사이트의 `config.json` 에 적는다.

```json
"statsApi": "https://cyanpro-stats.<계정>.workers.dev"
```

## 6. 확인

```bash
curl https://cyanpro-stats.<계정>.workers.dev/stats/summary
```

`{"duels":0,...}` 가 나오면 된다.

## 나중에 쿼리해 보기

```bash
wrangler d1 execute cyanpro-stats --remote \
  --command "SELECT COUNT(*) FROM duels"
```
