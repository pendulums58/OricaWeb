-- 사람 대전의 카드 사용 기록.
--
-- 호스트가 판마다 "한 번이라도 발동한 카드" 와 "한 번이라도 소환한 카드" 를
-- 보낸다. 횟수가 아니라 있다 / 없다다 — 명칭 턴 제한 때문에 전개 루트로 엮인
-- 카드는 발동 횟수가 다 똑같이 나와서 횟수로는 구별이 안 된다.
--
-- 덱에 있던 판을 "썼다 / 안 썼다" 로 나눠 각각 승률을 본다. 사용 시 승률만
-- 보면 이기는 판일수록 카드를 많이 쓰게 되니 거의 모든 카드가 부풀려진다.
-- 미사용 시 승률과 나란히 봐야 그 카드가 판을 바꾸는지 보인다.
--
-- has_play 는 그 판이 사용 기록을 보냈는지다. 이 컬럼이 생기기 전에 쌓인 판은
-- 0 이고, 집계에서 빠진다. 안 그러면 전부 "아무것도 안 쓴 판" 으로 잡힌다.

ALTER TABLE duels ADD COLUMN has_play INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS card_played (
  duel_id   TEXT NOT NULL,
  seat      INTEGER NOT NULL,
  card_id   INTEGER NOT NULL,
  activated INTEGER NOT NULL DEFAULT 0,   -- 이 판에 한 번이라도 발동했나
  summoned  INTEGER NOT NULL DEFAULT 0,   -- 이 판에 한 번이라도 소환했나
  PRIMARY KEY (duel_id, seat, card_id),
  FOREIGN KEY (duel_id) REFERENCES duels(duel_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_card_played_card ON card_played(card_id);
CREATE INDEX IF NOT EXISTS idx_duels_has_play   ON duels(has_play);
