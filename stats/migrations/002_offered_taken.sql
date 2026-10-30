-- 001 을 이미 실행한 뒤라면 이것만 추가로 실행한다.
-- 아직 안 했다면 schema.sql 이나 001 에 이미 반영돼 있으므로 필요 없다.
--
-- 분모를 "드로우 횟수"에서 "합법적 선택지로 제시된 횟수"로 바꾼다.
-- 서치·덤핑으로 꺼내 쓰는 비율이 높아 드로우는 접근 경로의 일부일 뿐이고,
-- 명칭 턴 제한 때문에 발동 횟수 자체에는 변별력이 없다.

ALTER TABLE card_usage RENAME COLUMN drawn  TO offered;
ALTER TABLE card_usage RENAME COLUMN played TO taken;
