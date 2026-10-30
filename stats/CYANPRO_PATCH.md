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
#include "game_config.h"   // gGameConfig (SSL 인증서 경로)
#include "data_manager.h"  // CardDataC
#include "bufferio.h"      // 이름 변환
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
// DuelPlayer::name 은 uint16_t[20] (UTF-16) 이다.
// 클라이언트가 이름을 표시할 때 쓰는 경로와 같게 UTF-8 로 바꾼다.
std::string PlayerName(const DuelPlayer* player) {
	if(!player)
		return {};
	wchar_t wname[20]{};
	BufferIO::DecodeUTF16(player->name, wname, 20);
	return BufferIO::EncodeUTF8(wname);
}

// 닉네임에는 따옴표도 역슬래시도 들어갈 수 있다. 그대로 넣으면 JSON 이 깨진다.
std::string JsonEscape(const std::string& in) {
	std::string out;
	out.reserve(in.size() + 8);
	for(unsigned char c : in) {
		switch(c) {
		case '"':  out += "\\\""; break;
		case '\\': out += "\\\\"; break;
		case '\n': out += "\\n"; break;
		case '\r': out += "\\r"; break;
		case '\t': out += "\\t"; break;
		default:
			if(c < 0x20) {
				char buf[7];
				snprintf(buf, sizeof(buf), "\\u%04x", c);
				out += buf;
			} else {
				out += static_cast<char>(c);   // UTF-8 바이트는 그대로
			}
		}
	}
	return out;
}

// WindBot 은 항상 name="[AI] {이름}" 으로 접속한다 (windbot.cpp).
// 봇이 낀 판은 통계에 넣지 않는다.
bool IsBotName(const uint16_t* name) {
	static const uint16_t prefix[] = { '[', 'A', 'I', ']', ' ' };
	for(size_t i = 0; i < sizeof(prefix) / sizeof(prefix[0]); ++i) {
		if(name[i] != prefix[i])
			return false;
	}
	return true;
}

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

		// 봇 대전은 보내지 않는다
		bool has_bot = false;
		for(const auto* d : seats) {
			if(d->player && IsBotName(d->player->name))
				has_bot = true;
		}

		if(seats.size() == 2 && !has_bot) {
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
				js << "{\"seat\":" << i
				   << ",\"name\":\"" << JsonEscape(PlayerName(seats[i]->player)) << "\""
				   << ",\"deck\":{";
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

## 봇 대전은 집계되지 않는다

WindBot 은 호스트가 띄운 뒤 **네트워크 클라이언트로 접속**하므로, 사람끼리의
방과 똑같이 `GenericDuel` 을 탄다. 아무 조치도 하지 않으면 봇 대전이 그대로
통계에 섞인다.

`DuelPlayer` 에는 봇 표시가 없고, 봇 프로세스 추적(`windbotsPids`)은
Linux / macOS 에서만 존재한다. 실질적으로 쓸 수 있는 신호는 **이름 접두사**다.
WindBot 은 `windbot.cpp` 에서 항상 `name="[AI] {이름}"` 으로 실행된다.

위 코드의 `IsBotName()` 이 그걸 검사해, 한쪽이라도 봇이면 보내지 않는다.

사람이 자기 이름을 `[AI] ` 로 시작하게 지으면 그 판도 빠진다. 기록이 덜 쌓일
뿐 통계가 오염되지는 않으므로, 틀릴 거면 이쪽으로 틀리는 게 맞다.

솔로 모드(`single_mode.cpp`)는 `GenericDuel` 을 쓰지 않으므로 애초에 해당이 없다.

## 플레이어 이름

닉네임을 함께 보낸다. 관리 화면에서 장난친 기록을 가려내려면 이름이 있어야
쓸 만하다.

**공개 통계에는 절대 나가지 않는다.** `/stats/cards` 와 `/stats/summary` 는
이름을 반환하지 않고, 관리자 토큰이 있는 `/admin/duels` 에서만 보인다.

### 이름을 그대로 넣으면 안 되는 이유

`DuelPlayer::name` 은 `uint16_t[20]` 인 UTF-16 배열이다. 두 가지를 거쳐야 한다.

1. **UTF-8 변환** — `DecodeUTF16` 으로 `wchar_t` 로 바꾼 뒤 `EncodeUTF8` 로 넘긴다.
   `wchar_t` 는 Windows 에서 16비트, Linux 에서 32비트라 직접 캐스팅하면 깨진다.
2. **JSON 이스케이프** — 닉네임에 `"` 나 `\` 가 들어가면 본문이 통째로 망가져
   서버가 400 을 돌려준다. 제어문자도 마찬가지다.

위 `PlayerName()` 과 `JsonEscape()` 가 그 두 가지를 한다.

## curl 초기화는 이미 돼 있다

`gframe.cpp` 가 시작할 때 `curl_global_init(CURL_GLOBAL_SSL)` 을 부르므로,
스레드 안에서 `curl_easy_init()` 을 바로 써도 된다. 따로 초기화할 필요 없다.

## 확인

1. `STATS_ENDPOINT` 를 실제 주소로 바꾼다
2. 빌드하고, 방을 판 뒤 한 듀얼을 끝까지 돌린다
3. `curl https://<주소>/stats/summary` 에서 `duels` 가 1 이 되면 성공

안 올라가면 `curl_easy_perform` 의 반환값을 로그로 찍어 보면 원인이 보인다.
