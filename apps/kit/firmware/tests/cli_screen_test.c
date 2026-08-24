/*
 * cli_screen_test: the frame says what the session is, and says it once.
 *
 * WHAT IS WORTH PROVING HERE. Not the escape sequences — a terminal is the
 * only thing that can judge those, and a test that asserted on them would
 * pin the cursor arithmetic rather than the meaning. What a person relies on
 * is that the two connectivity facts reach the frame unmangled, that the log
 * tail keeps the NEWEST lines rather than the first eight, and that a pass
 * which changed nothing writes nothing — the last of those being the only
 * thing standing between this and a terminal repainted a few hundred times a
 * second.
 */

#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "cli_screen.h"

static struct cli_screen screen;

static struct cli_screen_state baseline(void)
{
  const struct cli_screen_state state = {
    .stream_path = "/agents/voice2/ring1",
    .elapsed_ms = 20000U,
    .api_connected_at_ms = 8297U,
    .call_established_at_ms = 9730U,
    .call_pending = false,
    .transport_state = "ready",
    .space_held = true,
    .talking = true,
    .flushing = false,
    .mic_captured = 412U,
    .mic_held = 3U,
    .mic_sent = 408U,
    .mic_lost = 0U,
    .spk_received = 1326U,
    .spk_played = 1310U,
    .spk_ring_ms = 240U,
    .spk_conceal = 0U,
    .spk_underruns = 0U,
    .outbox_used = 2U,
    .outbox_slots = 64U,
    .loops = 41022U,
  };
  return state;
}

static void both_timestamps_reach_the_frame(void)
{
  memset(&screen, 0, sizeof(screen));
  cli_screen_enable(&screen, true);
  const struct cli_screen_state state = baseline();
  cli_screen_draw(&screen, &state);
  assert(screen.drawn_length > 0U);
  /* 20000 - 8297 = 11.7s, and 20000 - 9730 = 10.2s. */
  assert(strstr(screen.drawn, "11.7s ago") != NULL);
  assert(strstr(screen.drawn, "10.2s ago") != NULL);
  assert(strstr(screen.drawn, "/agents/voice2/ring1") != NULL);
  assert(strstr(screen.drawn, "SPACE HELD") != NULL);
  assert(strstr(screen.drawn, "TALKING") != NULL);
  cli_screen_enable(&screen, false);
}

static void an_unknown_epoch_draws_as_absent(void)
{
  memset(&screen, 0, sizeof(screen));
  cli_screen_enable(&screen, true);
  struct cli_screen_state state = baseline();
  state.api_connected_at_ms = 0U;
  state.call_established_at_ms = 0U;
  state.space_held = false;
  state.talking = false;
  cli_screen_draw(&screen, &state);
  /*
   * Never-connected must not render as "20.0s ago", which is what an age
   * computed against a zero epoch would say — and which reads as a healthy
   * connection made at startup.
   */
  assert(strstr(screen.drawn, "ago") == NULL);
  assert(strstr(screen.drawn, "SPACE HELD") == NULL);
  cli_screen_enable(&screen, false);
}

static void the_log_tail_keeps_the_newest(void)
{
  memset(&screen, 0, sizeof(screen));
  cli_screen_enable(&screen, true);
  for (size_t index = 0U; index < CLI_SCREEN_LOG_LINES + 3U; ++index) {
    char line[64];
    (void)snprintf(line, sizeof(line), "line-%zu", index);
    cli_screen_note(&screen, "info", line);
  }
  const struct cli_screen_state state = baseline();
  cli_screen_draw(&screen, &state);
  assert(screen.log_used == CLI_SCREEN_LOG_LINES);
  /* The three oldest are gone and the newest is present. */
  assert(strstr(screen.drawn, "line-0 ") == NULL);
  assert(strstr(screen.drawn, "line-2 ") == NULL);
  char newest[64];
  (void)snprintf(
      newest, sizeof(newest), "line-%zu", (size_t)CLI_SCREEN_LOG_LINES + 2U);
  assert(strstr(screen.drawn, newest) != NULL);
  cli_screen_enable(&screen, false);
}

static void an_unchanged_pass_writes_nothing(void)
{
  memset(&screen, 0, sizeof(screen));
  cli_screen_enable(&screen, true);
  const struct cli_screen_state state = baseline();
  cli_screen_draw(&screen, &state);
  const size_t after_first = screen.drawn_length;
  char first[CLI_SCREEN_FRAME_BYTES];
  memcpy(first, screen.drawn, after_first);
  /*
   * The same state ten thousand times is the normal case: the loop runs far
   * faster than anything on the frame changes. Nothing observable may move.
   */
  for (size_t index = 0U; index < 10000U; ++index) {
    cli_screen_draw(&screen, &state);
  }
  assert(screen.drawn_length == after_first);
  assert(memcmp(first, screen.drawn, after_first) == 0);

  /* One fact changes and the frame follows it. */
  struct cli_screen_state moved = state;
  moved.spk_played = 1311U;
  cli_screen_draw(&screen, &moved);
  assert(strstr(screen.drawn, "1311") != NULL);
  cli_screen_enable(&screen, false);
}

static void a_disabled_screen_is_inert(void)
{
  memset(&screen, 0, sizeof(screen));
  const struct cli_screen_state state = baseline();
  cli_screen_draw(&screen, &state);
  cli_screen_note(&screen, "info", "swallowed");
  assert(screen.drawn_length == 0U);
  assert(screen.log_used == 0U);
  assert(cli_screen_active() == NULL);
}

int main(void)
{
  both_timestamps_reach_the_frame();
  an_unknown_epoch_draws_as_absent();
  the_log_tail_keeps_the_newest();
  an_unchanged_pass_writes_nothing();
  a_disabled_screen_is_inert();
  (void)printf("cli_screen_test ok\n");
  return 0;
}
