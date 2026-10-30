-- 이미 schema.sql 을 적용한 뒤라면 이것만 실행한다.
-- 처음 만드는 경우에는 schema.sql 에 이미 포함돼 있으므로 필요 없다.

ALTER TABLE duels ADD COLUMN source TEXT NOT NULL DEFAULT 'human';

CREATE TABLE IF NOT EXISTS card_usage (
  duel_id TEXT NOT NULL,
  seat    INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  offered INTEGER NOT NULL DEFAULT 0,
  taken   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (duel_id, seat, card_id),
  FOREIGN KEY (duel_id) REFERENCES duels(duel_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_card_usage_card ON card_usage(card_id);
CREATE INDEX IF NOT EXISTS idx_duels_source    ON duels(source);
