-- CyanPro 듀얼 통계 — D1 스키마
--
-- 원본 덱을 그대로 남긴다. 집계값만 저장하면 나중에 지표를 바꿀 때
-- 과거 기록을 다시 계산할 수 없다.

CREATE TABLE IF NOT EXISTS duels (
  duel_id     TEXT PRIMARY KEY,   -- 리플레이 시드. 듀얼마다 고유하므로 중복 제거 키가 된다
  match_id    TEXT,               -- 매치 첫 듀얼의 시드
  game_no     INTEGER,            -- 매치 내 몇 번째 듀얼인지 (1부터)
  format      TEXT,               -- 금제 리스트 이름
  winner      INTEGER NOT NULL,   -- 0 또는 1
  ended_at    INTEGER,            -- 듀얼 종료 시각 (유닉스 초)
  version     TEXT,               -- CyanPro 버전
  reporter    TEXT,               -- 보고한 호스트 식별자 (익명 해시)
  received_at INTEGER NOT NULL,
  hidden      INTEGER NOT NULL DEFAULT 0,  -- 관리자가 걸러낸 기록
  note        TEXT,
  source      TEXT NOT NULL DEFAULT 'human'  -- human | sim
);

CREATE TABLE IF NOT EXISTS duel_players (
  duel_id TEXT NOT NULL,
  seat    INTEGER NOT NULL,       -- 0 또는 1
  name    TEXT,                   -- 공개 통계에는 절대 나가지 않는다
  won     INTEGER NOT NULL,
  PRIMARY KEY (duel_id, seat),
  FOREIGN KEY (duel_id) REFERENCES duels(duel_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deck_cards (
  duel_id TEXT NOT NULL,
  seat    INTEGER NOT NULL,
  zone    TEXT NOT NULL,          -- main / extra / side
  card_id INTEGER NOT NULL,
  qty     INTEGER NOT NULL,
  PRIMARY KEY (duel_id, seat, zone, card_id),
  FOREIGN KEY (duel_id) REFERENCES duels(duel_id) ON DELETE CASCADE
);

-- 카드별 선택 기록. 시뮬레이션에서만 채워진다.
--
-- 분모는 드로우가 아니라 "엔진이 합법적 선택지로 제시한 횟수" 다.
-- 서치·덤핑·덱 특수소환으로 꺼내 쓰는 비율이 높고, 명칭 턴 제한 때문에
-- 발동 횟수 자체는 변별력이 없기 때문이다.
--
--   offered 0                → 기회가 없었음 (루트 미성립 / 서치 실패)
--   offered 많음, taken 0    → AI 가 쓸 줄 모름. 그 카드 승률은 근거가 못 됨
--   offered 많음, taken 많음 → 이해함. 승률 참고 가능
CREATE TABLE IF NOT EXISTS card_usage (
  duel_id TEXT NOT NULL,
  seat    INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  offered INTEGER NOT NULL DEFAULT 0,  -- 합법적 선택지로 제시된 횟수
  taken   INTEGER NOT NULL DEFAULT 0,  -- 그중 실제로 고른 횟수
  PRIMARY KEY (duel_id, seat, card_id),
  FOREIGN KEY (duel_id) REFERENCES duels(duel_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deck_cards_card ON deck_cards(card_id);
CREATE INDEX IF NOT EXISTS idx_card_usage_card ON card_usage(card_id);
CREATE INDEX IF NOT EXISTS idx_duels_source     ON duels(source);
CREATE INDEX IF NOT EXISTS idx_duels_received  ON duels(received_at);
CREATE INDEX IF NOT EXISTS idx_duels_hidden    ON duels(hidden);
