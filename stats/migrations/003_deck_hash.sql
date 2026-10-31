-- 같은 레시피의 덱을 하나로 세기 위한 지문.
--
-- 메인 + 엑스트라 구성에서만 뽑는다. 사이드는 넣지 않는다 —
-- 호스트가 보내는 덱은 사이드 교체가 끝난 상태라, 2선승 매치의 2·3차전이
-- 1차전과 다른 리스트로 들어오기 때문이다.
--
-- 고유 덱 집계는 game_no = 1 인 판만 센다. 그 판이 사이드 교체 전 원본이다.

ALTER TABLE duel_players ADD COLUMN deck_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_players_hash ON duel_players(deck_hash);
