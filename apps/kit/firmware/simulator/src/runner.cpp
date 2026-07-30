#include "iterate/kit/simulator/runner.hpp"

#include <cerrno>
#include <chrono>
#include <cstddef>
#include <cstdio>
#include <cstring>

#include <sys/select.h>
#include <unistd.h>

namespace iterate::kit::simulator {
namespace {

/*
 * These are host-integration limits, not recommended ESP32 budgets. The
 * process accepts a complete Cap'n Web text message so TypeScript can exercise
 * large results (including encoded photos), while every table and scratch area
 * remains fixed and caller-owned just like the firmware library requires.
 *
 * A 64 KiB input cap prevents a missing newline or hostile test process from
 * growing memory without bound. The much smaller output scratch is deliberate:
 * Cap'n Web must stream a response in fragments rather than assume one giant
 * reply allocation. Table exhaustion remains a visible CAPNWEB_E_LIMIT instead
 * of silently expanding a host container and hiding target-invalid behaviour.
 */
constexpr std::size_t messageCapacity = 65'536U;
constexpr std::size_t tokenCapacity = 256U;
constexpr std::size_t pendingCallCapacity = 16U;
constexpr std::size_t exportCapacity = 16U;
constexpr std::size_t importCapacity = 16U;
constexpr std::size_t outputCapacity = 128U;

/*
 * BEGIN/DATA/END is a transaction even though stdout itself is a byte stream.
 * Tracking the open state makes malformed fragment sequences fail here rather
 * than emit plausible-looking JSON that lets the TypeScript peer continue with
 * corrupt protocol state. The runner has one owner thread, so this state needs
 * no locking and intentionally does not pretend to model cross-task writes.
 */
struct StandardOutputTransport {
  bool messageOpen = false;
};

capnweb_status sendText(
    void *context,
    capnweb_text_fragment_kind kind,
    const char *data,
    std::size_t length) {
  auto &transport = *static_cast<StandardOutputTransport *>(context);
  switch (kind) {
    case CAPNWEB_TEXT_BEGIN:
      /*
       * Nested messages would interleave two Cap'n Web records on stdout.
       * Rejecting them protects the one-line/one-message framing contract used
       * by the real peer adapter.
       */
      if (transport.messageOpen) return CAPNWEB_E_TRANSPORT;
      transport.messageOpen = true;
      return CAPNWEB_OK;
    case CAPNWEB_TEXT_DATA:
      /*
       * A short stdio write would truncate one protocol record. There is no
       * meaningful retry cursor in this adapter, so fail the session visibly
       * instead of emitting a prefix that the peer might hold forever.
       */
      if (!transport.messageOpen ||
          (length > 0U &&
           (data == nullptr ||
            std::fwrite(data, 1U, length, stdout) != length))) {
        return CAPNWEB_E_TRANSPORT;
      }
      return CAPNWEB_OK;
    case CAPNWEB_TEXT_END:
      /*
       * Flush at the message boundary, not after every fragment. This gives the
       * controlling process prompt replies without turning fragmentation into
       * a series of expensive syscalls. Successful flush proves only host-pipe
       * delivery; WebSocket and peer confirmation have separate tests.
       */
      if (!transport.messageOpen ||
          std::fputc('\n', stdout) == EOF ||
          std::fflush(stdout) != 0) {
        return CAPNWEB_E_TRANSPORT;
      }
      transport.messageOpen = false;
      return CAPNWEB_OK;
  }
  return CAPNWEB_E_TRANSPORT;
}

int waitForInput() {
  /*
   * A blocking read would stop device.poll() whenever the controlling peer is
   * quiet, starving metrics subscriptions and lifecycle work. Ten milliseconds
   * keeps this general-purpose simulator responsive without busy-spinning a
   * developer CPU. It is not the firmware audio cadence and must never be used
   * as evidence for PCM latency; the realtime harness uses explicit clocks and
   * scheduling instead.
   */
  fd_set descriptors;
  FD_ZERO(&descriptors);
  FD_SET(STDIN_FILENO, &descriptors);
  timeval timeout{0, 10'000};
  return select(
      STDIN_FILENO + 1,
      &descriptors,
      nullptr,
      nullptr,
      &timeout);
}

bool validDevice(const iterate_kit_device &device) {
  /*
   * The C device handle is intentionally type-erased, so an incomplete board
   * adapter can otherwise survive initialization and fail as a null call much
   * later. Rejecting it at the composition boundary classifies that as a setup
   * defect and guarantees the event loop always has dispatch/poll/close.
   */
  return device.manifest != nullptr &&
      device.manifest->slug != nullptr &&
      device.capability.dispatch != nullptr &&
      device.poll != nullptr &&
      device.close != nullptr;
}

}  // namespace

std::uint64_t monotonicMilliseconds() {
  /*
   * steady_clock cannot jump with NTP or wall-clock changes. Absolute epoch is
   * meaningless here; only nondecreasing intervals passed to profile pollers
   * are part of the contract.
   */
  const auto elapsed = std::chrono::steady_clock::now().time_since_epoch();
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count());
}

int run(const Definition &definition) {
  /*
   * All protocol storage is explicit and lives for the whole event loop. This
   * mirrors the no-allocator portable library API and makes accidental table
   * growth become a deterministic limit error. The arrays are host stack cost;
   * they are deliberately excluded from claims about a target task's stack,
   * whose budgets are measured by the firmware build and runtime telemetry.
   */
  capnweb_session session{};
  capnweb_pending_call pendingCalls[pendingCallCapacity]{};
  capnweb_export exports[exportCapacity]{};
  capnweb_import imports[importCapacity]{};
  capnweb_json_token tokens[tokenCapacity]{};
  char outputBuffer[outputCapacity]{};
  /*
   * The extra byte is overflow lookahead, not payload budget. It leaves room to
   * observe the newline after an exactly messageCapacity-byte record; without
   * it the runner would reject a valid boundary-size message merely because it
   * could not yet distinguish "complete" from "keeps growing".
   */
  char inputBuffer[messageCapacity + 1U]{};
  std::size_t inputLength = 0U;
  StandardOutputTransport transport{};
  iterate_kit_device device{};

  /*
   * Profiles need the eventual session address in their metrics/capability
   * options, while session initialization needs the profile's root capability.
   * Passing a stable zero-initialized session to initialize() resolves that
   * dependency without allocation. The initializer may retain the address but
   * must not use the session until capnweb_session_init succeeds below.
   */
  if (definition.name == nullptr ||
      definition.initialize == nullptr ||
      definition.initialize(
          definition.context, &session, &device) != CAPNWEB_OK ||
      !validDevice(device)) {
    std::fprintf(
        stderr,
        "%s simulator initialization failed\n",
        definition.name == nullptr ? "Kit" : definition.name);
    return 1;
  }

  const capnweb_session_options sessionOptions{
    device.capability,
    sendText,
    &transport,
    pendingCalls,
    pendingCallCapacity,
    exports,
    exportCapacity,
    imports,
    importCapacity,
    tokens,
    tokenCapacity,
    outputBuffer,
    outputCapacity,
  };
  capnweb_status status = capnweb_session_init(&session, &sessionOptions);
  if (status != CAPNWEB_OK) {
    std::fprintf(stderr, "Cap'n Web init failed: %d\n", status);
    return 1;
  }

  /*
   * The runner deliberately serializes receive and poll on one owner thread,
   * matching the portable capability layer's ownership rule. Concurrency bugs
   * at ISR/audio/socket boundaries are not "simulated" with nondeterministic
   * host threads; deterministic model tests exercise those protocols instead.
   */
  for (;;) {
    const int ready = waitForInput();
    if (ready < 0) {
      /*
       * Signals do not imply transport failure. Retrying EINTR is bounded by
       * external signal arrival and preserves the session; every other select
       * error is surfaced so an unattended test cannot silently stop polling.
       */
      if (errno == EINTR) continue;
      std::perror("select");
      status = CAPNWEB_E_TRANSPORT;
      break;
    }
    if (ready > 0) {
      /*
       * stdin is a stream: reads may split or coalesce messages. Accumulating
       * into one bounded buffer and recognizing only newline boundaries avoids
       * treating host pipe chunking as Cap'n Web framing. Empty lines are still
       * delivered and rejected by the protocol parser rather than ignored as a
       * hidden compatibility behaviour.
       */
      const ssize_t received = read(
          STDIN_FILENO,
          inputBuffer + inputLength,
          sizeof(inputBuffer) - inputLength);
      if (received == 0) break;
      if (received < 0) {
        if (errno == EINTR) continue;
        std::perror("read");
        status = CAPNWEB_E_TRANSPORT;
        break;
      }
      inputLength += static_cast<std::size_t>(received);

      for (;;) {
        const auto *newline = static_cast<const char *>(
            std::memchr(inputBuffer, '\n', inputLength));
        if (newline == nullptr) break;
        std::size_t messageLength =
            static_cast<std::size_t>(newline - inputBuffer);
        if (messageLength > 0U &&
            inputBuffer[messageLength - 1U] == '\r') {
          --messageLength;
        }
        status = capnweb_session_receive(
            &session, inputBuffer, messageLength);
        if (status != CAPNWEB_OK) {
          std::fprintf(stderr, "Cap'n Web receive failed: %d\n", status);
          break;
        }

        const std::size_t consumed =
            static_cast<std::size_t>(newline - inputBuffer) + 1U;
        inputLength -= consumed;
        /*
         * A ring would avoid this copy, but at most one bounded host-test
         * message is normally pending and clarity is more valuable here. This
         * path is not included in target CPU claims. The hard 64 KiB limit
         * keeps even an adversarial no-newline stream bounded.
         */
        std::memmove(inputBuffer, inputBuffer + consumed, inputLength);
      }
      if (status != CAPNWEB_OK) break;
      if (inputLength == sizeof(inputBuffer)) {
        std::fprintf(stderr, "CAPNWEB_E_INPUT_LIMIT\n");
        status = CAPNWEB_E_LIMIT;
        break;
      }
    }

    /*
     * Poll even when no input arrived. Metrics subscriptions and queued device
     * events are time/work driven, so tying progress only to RPC traffic would
     * make an idle connection appear healthy while background work stalls.
     * Each profile is responsible for bounding one poll pass.
     */
    const iterate_kit_poll_result pollResult =
        device.poll(device.context, monotonicMilliseconds());
    if (pollResult.status == ITERATE_KIT_POLL_CAPNWEB_ERROR) {
      status = pollResult.capnweb_status;
      std::fprintf(
          stderr,
          "%s poll failed: %d\n",
          definition.name,
          status);
      break;
    }
  }

  /*
   * Close transfers/revokes profile-owned protocol state and must happen once
   * on EOF as well as failure. Preserve the first receive/transport error: a
   * secondary close error is useful only when no earlier cause already explains
   * termination. Session cleanup follows profile close because profile modules
   * may release Cap'n Web capabilities during their close path.
   */
  const iterate_kit_poll_result closeResult =
      device.close(device.context);
  if (status == CAPNWEB_OK &&
      closeResult.status == ITERATE_KIT_POLL_CAPNWEB_ERROR) {
    status = closeResult.capnweb_status;
  }
  capnweb_session_close(&session);
  return status == CAPNWEB_OK ? 0 : 1;
}

}  // namespace iterate::kit::simulator
