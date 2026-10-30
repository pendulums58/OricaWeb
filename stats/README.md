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
| `duels` | 듀얼 한 건. 승자, 포맷, 시각, 숨김 여부 |
| `duel_players` | 자리별 플레이어와 승패. **이름은 공개 통계에 나가지 않는다** |
| `deck_cards` | (듀얼, 자리, 존, 카드) 별 매수 |

무승부는 `winner = 2` 로 저장하고, 승률 분모에서 빠진다.

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
