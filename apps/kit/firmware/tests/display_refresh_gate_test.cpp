#include "iterate/kit/platforms/display_refresh_gate.hpp"

#include <cstddef>
#include <cstdio>
#include <cstdlib>

namespace {

void testAssert(
    bool condition,
    const char *expression,
    const char *file,
    int line) {
  if (condition) return;
  std::fprintf(
      stderr,
      "%s:%d: assertion failed: %s\n",
      file,
      line,
      expression);
  std::abort();
}

#define TEST_ASSERT(expression) \
  testAssert((expression), #expression, __FILE__, __LINE__)

using DisplayRefreshGate =
    iterate::kit::platforms::DisplayRefreshGate;

/*
 * Screen rendering can monopolize the SPI bus/CPU long enough to starve I2S or
 * socket servicing, but dropping every refresh during a long PTT hold would
 * leave the UI permanently stale. A timed display queue is unnecessary state
 * and another source of backlog. This test pins a coalescing dirty bit: no
 * render work escapes while realtime audio is active, and exactly one refresh
 * becomes eligible as soon as the audio-critical interval ends.
 */
void defersDisplayWorkWhileRealtimeAudioIsActive() {
  /*
   * The gate is instantiated on small devices and sits on a hot scheduling
   * path; it should express only “audio active” and “refresh owed.” Growth into
   * a queued scheduler would cost RAM and preserve obsolete UI work. This size
   * gate makes that two-bit mental model an explicit compile-time constraint.
   */
  static_assert(
      sizeof(DisplayRefreshGate) <= 2U,
      "display scheduling must remain two booleans");

  DisplayRefreshGate gate{};
  gate.markDirty();
  TEST_ASSERT(gate.consumeIfIdle());
  TEST_ASSERT(!gate.consumeIfIdle());

  gate.observeRealtimeAudioActive(true);
  gate.markDirty();
  for (std::size_t frame = 0U; frame < 128U; ++frame) {
    gate.observeRealtimeAudioActive(true);
    TEST_ASSERT(!gate.consumeIfIdle());
  }

  gate.observeRealtimeAudioActive(false);
  TEST_ASSERT(gate.consumeIfIdle());
  TEST_ASSERT(!gate.consumeIfIdle());
}

}  // namespace

int main() {
  defersDisplayWorkWhileRealtimeAudioIsActive();
  return 0;
}
