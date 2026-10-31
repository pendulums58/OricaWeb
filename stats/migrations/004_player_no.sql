-- 매치 안에서 사람을 고정 식별하는 번호.
--
-- 진 쪽이 선공을 고르면 GenericDuel::TPResult() 가 players.home 과
-- players.opposing 을 통째로 바꾼다. seat 은 그래서 매치 중간에 뒤집히고,
-- 매치를 가로질러 같은 사람을 묶는 기준이 되지 못한다.

ALTER TABLE duel_players ADD COLUMN player_no INTEGER;
