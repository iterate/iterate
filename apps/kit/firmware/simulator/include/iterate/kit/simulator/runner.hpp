#ifndef ITERATE_KIT_SIMULATOR_RUNNER_HPP
#define ITERATE_KIT_SIMULATOR_RUNNER_HPP

#include "iterate/kit/device.h"

#include <cstdint>

namespace iterate::kit::simulator {

/*
 * A simulator is a newline-delimited Cap'n Web peer over stdin/stdout. This
 * intentionally reuses the real C session and device profile instead of
 * reimplementing their behaviour in TypeScript: an off-device end-to-end test
 * therefore catches protocol, dispatch, storage-lifetime, polling, and close
 * regressions on the same code shipped to the board.
 *
 * The stdio transport is not a WebSocket, and the host process is not a timing
 * or resource analogue for an ESP32. Socket framing/backpressure, reconnects,
 * TLS/lwIP buffering, FreeRTOS priorities, and hardware drivers are proven by
 * their dedicated fault harnesses and device tests rather than inferred from
 * this runner.
 */
using InitializeDevice = capnweb_status (*)(
    void *context,
    capnweb_session *session,
    iterate_kit_device *device);

struct Definition {
  /*
   * The runner borrows all three fields for the entire call to run(). The
   * initializer must build the device from caller-owned storage reachable from
   * `context`; neither the session nor the returned type-erased device may
   * outlive that storage.
   */
  const char *name;
  void *context;
  InitializeDevice initialize;
};

/* The clock is monotonic milliseconds because profiles schedule intervals,
 * not civil-time events. Its resolution and jitter are host properties and do
 * not establish a realtime latency bound. */
std::uint64_t monotonicMilliseconds();

/*
 * Runs one single-owner event loop until EOF or a classified protocol/I/O
 * failure, then closes the device exactly once. A zero result proves a clean
 * protocol lifecycle; it does not mean the simulated hardware did real work.
 */
int run(const Definition &definition);

}  // namespace iterate::kit::simulator

#endif
