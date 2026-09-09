#include "iterate/kit/voice/loop.h"

#include <assert.h>
#include <stddef.h>
#include <string.h>

/** Complete view inputs and the visual snapshot they must produce. */
struct voice_lights_case {
  struct iterate_kit_voice_view view;
  struct iterate_kit_conversation_visual_state becomes;
};

int main(void) {
  const struct voice_lights_case cases[] = {
    {{0}, {.network = ITERATE_KIT_NETWORK_CONNECTING}},
    {{.api_ready = true}, {.reach = ITERATE_KIT_REACH_API}},
    {{.api_ready = true, .stream_ready = true, .link_ready = true},
     {.network = ITERATE_KIT_NETWORK_CONNECTED, .reach = ITERATE_KIT_REACH_STREAM,
      .media_ready = true}},
    {{.link_ready = true, .wants_call = true},
     {.network = ITERATE_KIT_NETWORK_CONNECTED, .media_ready = false}},
    {{.api_ready = true, .stream_ready = true, .link_ready = true,
      .call_active = true, .wants_call = true,
      .screen = ITERATE_KIT_VOICE_SCREEN_LISTENING, .microphone_peak = 1234},
     {.network = ITERATE_KIT_NETWORK_CONNECTED, .reach = ITERATE_KIT_REACH_SESSION,
      .conversation_active = true, .media_ready = true,
      .microphone_listening = true, .microphone_peak = 1234}},
    {{.screen = ITERATE_KIT_VOICE_SCREEN_SPEAKING, .fault = true},
     {.media_failed = true, .speaker_peak = 4096}},
    {{.talk_held = true, .listening = true}, {0}},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    struct iterate_kit_conversation_visual_state actual;
    memset(&actual, 0xff, sizeof(actual));
    iterate_kit_voice_view_lights(&cases[i].view, &actual);
    const struct iterate_kit_conversation_visual_state *expected = &cases[i].becomes;
    assert(actual.network == expected->network);
    assert(actual.reach == expected->reach);
    assert(actual.has_wifi_rssi == expected->has_wifi_rssi);
    assert(actual.wifi_rssi_dbm == expected->wifi_rssi_dbm);
    assert(actual.conversation_active == expected->conversation_active);
    assert(actual.media_ready == expected->media_ready);
    assert(actual.media_failed == expected->media_failed);
    assert(actual.microphone_listening == expected->microphone_listening);
    assert(actual.microphone_peak == expected->microphone_peak);
    assert(actual.speaker_peak == expected->speaker_peak);
    assert(actual.restart_armed == expected->restart_armed);
  }
  return 0;
}
