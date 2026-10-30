# CyanPro 쪽 작업

`gframe/generic_duel.cpp` 와 `generic_duel.h` 만 고치면 된다. 새 파일을 추가하지
않으므로 빌드 설정은 건드릴 필요가 없다.

> 이 코드는 컴파일해 보지 않았다. 실제 타입에 맞춰 적었지만
> (`Deck::Vector` 는 `std::vector<const CardDataC*>` 이고 카드 ID 는 `code`),
> 포크 상태에 따라 헤더 경로가 다를 수 있다. 안 맞으면 알려 달라.

## 1. 헤더에 멤버 추가 — `generic_duel.h`

`class GenericDuel` 안, 다른 멤버들 옆에 넣는다.

```cpp
	// 듀얼 통계 보고용
	std::string stat_duel_id;     // 이번 듀얼의 시드 (고유 ID)
	std::string stat_match_id;    // 매치 첫 듀얼의 시드
	int stat_game_no = 0;         // 매치 내 몇 번째 듀얼인지
```

## 2. 듀얼 시작 시 시드 보관 — `generic_duel.cpp`

`TPResult()` 안, 575줄 근처다. 원래 이렇게 돼 있다.

```cpp
	const auto seed = Utils::GetRandomNumberGeneratorSeed();
	auto replay_header = ExtendedReplayHeader::CreateDefaultHeader(REPLAY_YRP1, static_cast<uint32_t>(time(nullptr)));
	replay_header.SetSeed(seed);
```

바로 아래에 추가한다.

```cpp
	// 시드를 그대로 듀얼 ID 로 쓴다. 듀얼마다 새로 생기므로 중복되지 않는다.
	{
		char buf[65];
		snprintf(buf, sizeof(buf), "%016llx%016llx",
			(unsigned long long)seed[0], (unsigned long long)seed[1]);
		stat_duel_id = buf;
		++stat_game_no;
		if(stat_match_id.empty())
			stat_match_id = stat_duel_id;   // 매치의 첫 듀얼
	}
```

매치가 끝나 새 매치가 시작될 때 초기화해야 한다. `DuelEndProc()` 안에서
`seeking_rematch = true;` 를 설정하는 블록(매치 종료 분기) 안에 넣는다.

```cpp
		stat_match_id.clear();
		stat_game_no = 0;
```

## 3. 듀얼이 끝날 때 보내기 — `generic_duel.cpp`

파일 위쪽 `#include` 들 옆에 추가한다.

```cpp
#include <thread>
#include <sstream>
#include "curl.h"
#include "config.h"        // 버전 매크로
#include "data_manager.h"  // CardDataC
```

파일 안 익명 네임스페이스(또는 `GenericDuel` 구현 위쪽)에 헬퍼를 둔다.

```cpp
namespace {

// 통계 서버 주소. 비워 두면 아무것도 보내지 않는다.
constexpr const char* STATS_ENDPOINT = "https://cyanpro-stats.<계정>.workers.dev/duels";

void PostDuelStats(std::string payload) {
	if(!STATS_ENDPOINT || !*STATS_ENDPOINT || payload.empty())
		return;
	// 게임 흐름을 막지 않도록 별도 스레드에서 보낸다. 실패해도 무시한다.
	std::thread([payload = std::move(payload)]() {
		CURL* curl = curl_easy_init();
		if(!curl)
			return;
		curl_slist* headers = nullptr;
		headers = curl_slist_append(headers, "Content-Type: application/json");
		curl_easy_setopt(curl, CURLOPT_URL, STATS_ENDPOINT);
		curl_easy_setopt(curl, CURLOPT_POST, 1L);
		curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload.c_str());
		curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)payload.size());
		curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
		curl_easy_setopt(curl, CURLOPT_TIMEOUT, 10L);
		curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
		curl_easy_setopt(curl, CURLOPT_NOPROXY, "*");
		curl_easy_setopt(curl, CURLOPT_USERAGENT, ygo::Utils::GetUserAgent().data());
		if(!gGameConfig->ssl_certificate_path.empty())
			curl_easy_setopt(curl, CURLOPT_CAINFO, gGameConfig->ssl_certificate_path.data());
		curl_easy_perform(curl);
		curl_slist_free_all(headers);
		curl_easy_cleanup(curl);
	}).detach();
}

// Deck 의 각 존은 std::vector<const CardDataC*> 다. 카드 ID 는 code 필드에 있다.
void AppendCardArray(std::ostringstream& out, const char* key,
                     const Deck::Vector& cards) {
	out << '"' << key << "\":[";
	bool first = true;
	for(const auto* card : cards) {
		if(!card)
			continue;
		if(!first) out << ',';
		first = false;
		out << card->code;
	}
	out << ']';
}

} // namespace
```

`DuelEndProc()` 의 맨 앞, `EndDuel();` 바로 다음에 넣는다. 이 시점에
`match_result` 의 마지막 값이 이번 듀얼의 승자다 (0 / 1, 2 는 무승부).

```cpp
	// ---- 듀얼 통계 보고 ----
	if(!match_result.empty() && !stat_duel_id.empty()) {
		const int winner = match_result.back();
		std::vector<const duelist*> seats;
		IteratePlayers([&seats](duelist& d) { seats.push_back(&d); });
		if(seats.size() == 2) {
			std::ostringstream js;
			js << '{'
			   << "\"duel_id\":\"" << stat_duel_id << "\","
			   << "\"match_id\":\"" << stat_match_id << "\","
			   << "\"game_no\":" << stat_game_no << ','
			   << "\"winner\":" << winner << ','
			   << "\"ended_at\":" << (long long)time(nullptr) << ','
			   << "\"version\":\"" << EDOPRO_VERSION_MAJOR << '.'
			                      << EDOPRO_VERSION_MINOR << '.'
			                      << EDOPRO_VERSION_PATCH << "\","
			   << "\"players\":[";
			for(size_t i = 0; i < seats.size(); ++i) {
				const Deck& deck = seats[i]->pdeck;
				if(i) js << ',';
				js << "{\"seat\":" << i << ",\"deck\":{";
				AppendCardArray(js, "main", deck.main);
				js << ',';
				AppendCardArray(js, "extra", deck.extra);
				js << ',';
				AppendCardArray(js, "side", deck.side);
				js << "}}";
			}
			js << "]}";
			PostDuelStats(js.str());
		}
	}
```

## 플레이어 이름

위 코드는 **이름을 보내지 않는다.** 통계에는 필요 없고, 보내지 않으면 개인정보를
다룰 일도 없다.

관리 화면에서 "이건 누가 장난친 기록이다" 를 가려내려면 이름이 있는 편이
편하다. 넣으려면 `"seat"` 다음에 한 줄 더한다.

```cpp
				js << ",\"name\":\"" << seats[i]->player->name << "\"";
```

이름에 따옴표나 역슬래시가 들어갈 수 있으니, 넣을 거면 escape 를 한 번 거쳐야
한다. 없이 가는 쪽을 권한다.

## 확인

1. `STATS_ENDPOINT` 를 실제 주소로 바꾼다
2. 빌드하고, 방을 판 뒤 한 듀얼을 끝까지 돌린다
3. `curl https://<주소>/stats/summary` 에서 `duels` 가 1 이 되면 성공

안 올라가면 `curl_easy_perform` 의 반환값을 로그로 찍어 보면 원인이 보인다.
