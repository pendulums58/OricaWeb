-- 개시 때 덱에서 패로 가져온 카드.
--
-- 단짝은 듀얼 시작 시 조건이 맞으면 지정할 수 있고, 지정하면 지금은 바로 패로
-- 온다. 그 +1 장이 승률에 관여하는 부분이다. 이미 손에 있던 단짝을 지정한
-- 판은 이득이 없으므로 세지 않는다 — 호스트가 "듀얼 시작부터 1턴 스탠바이
-- 페이즈 전까지, 효과로 덱에서 패로 온 카드" 만 보낸다.
--
-- 지정 자체는 EFFECT_TYPE_CONTINUOUS 라 체인을 만들지 않아 발동 기록에 안 잡힌다.
-- 가져옴은 "사용" 에 포함된다.
--
-- has_fetch 는 그 판이 이 기록을 보냈는지다. 1.0.8 은 발동 · 소환만 보내므로
-- has_play = 1, has_fetch = 0 인 판이 생긴다. 그 판에서는 가져오기만 하고
-- 발동도 소환도 안 한 단짝이 미사용으로 잡힌다.

ALTER TABLE card_played ADD COLUMN fetched INTEGER NOT NULL DEFAULT 0;
ALTER TABLE duels ADD COLUMN has_fetch INTEGER NOT NULL DEFAULT 0;
