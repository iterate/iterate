#ifndef ITERATE_KIT_PLATFORMS_REALTIME_OWNER_CONTROL_HPP
#define ITERATE_KIT_PLATFORMS_REALTIME_OWNER_CONTROL_HPP

#include "iterate/kit/status.h"

#include <atomic>
#include <cstdint>
#include <type_traits>

namespace iterate::kit::platforms {

/**
 * Zero-cost production hook for deterministic publication-order tests.
 *
 * The command mailbox has one especially important cross-atomic interleaving:
 * owner completion can land between the producer's first and second state
 * observations. A probabilistic thread race is not a useful regression test,
 * so tests inject a hook at that exact boundary. The default's templated no-op
 * is inlined away and does not add a branch, object, or callback to firmware.
 */
struct NoopOwnerMailboxInterleave {
  template<typename Mailbox>
  static void afterFirstStateObservation(Mailbox &) {}
};

/**
 * One-slot command rendezvous between an application task and an audio owner.
 *
 * A socket-generation fence is unusual: the network/application task must not
 * admit new PCM until the audio task proves old DMA is physically unreachable,
 * but that caller must also never block behind an I2S or codec operation. This
 * mailbox turns the public fence into a poll:
 *
 *  - the first request publishes one command and returns UNAVAILABLE;
 *  - the sole audio owner takes and executes that command exactly once;
 *  - a later byte-identical request consumes the owner's result;
 *  - no second slot exists, so reconnect churn cannot create a lifecycle FIFO;
 *  - a missing acknowledgement becomes IO_ERROR at a fixed monotonic deadline.
 *
 * `request()` belongs to one producer task. `take()` and `complete()` belong
 * to one audio task. Commands/results contain no PCM and allocation never
 * occurs. The release/acquire pairs publish the adjacent plain payload:
 * `pending_` publishes request_, while `completionReady_` publishes
 * completion_/completionResult_. The owner keeps pending_ set while executing,
 * which prevents the producer from overwriting payload under an in-flight
 * operation.
 *
 * A timed-out operation remains physically owned by the audio task and may
 * still finish, but this mailbox permanently fails closed. Reporting a late
 * OK would let the transport reopen after a period in which the hardware's
 * state was unknowable.
 */
template<
    typename Command,
    std::uint32_t MaximumAcknowledgementMs,
    typename Interleave = NoopOwnerMailboxInterleave>
class SingleOwnerCommandMailbox {
  static_assert(std::is_enum<Command>::value);
  static_assert(MaximumAcknowledgementMs > 0U);
#if !defined(ESP_PLATFORM)
  static_assert(
      std::atomic<std::uint32_t>::is_always_lock_free,
      "host command publication must not hide a lock");
#endif

 public:
  struct Envelope {
    Command command{};
    std::uint32_t generation = 0U;
    bool connected = false;
  };

  iterate_kit_status request(
      Command command,
      std::uint32_t generation,
      bool connected,
      std::uint64_t nowMs) {
    if (failed_) {
      return ITERATE_KIT_IO_ERROR;
    }

    /*
     * Observe the owner-held slot before its adjacent completion flag. The
     * owner publishes completionReady_ and only then releases pending_. If
     * this acquire sees pending_ become zero, C++ happens-before guarantees
     * the following completion load sees that published result. Reversing
     * these loads permits the producer to miss a just-published completion,
     * see the newly idle slot, and enqueue duplicate physical work whose old
     * matching result can then be acknowledged prematurely.
     */
    const auto pending =
        pending_.load(std::memory_order_acquire);
    Interleave::afterFirstStateObservation(*this);
    if (pending != 0U) {
      if (nowMs < submittedAtMs_ ||
          nowMs - submittedAtMs_ >=
              MaximumAcknowledgementMs) {
        failed_ = true;
        return ITERATE_KIT_IO_ERROR;
      }
      return ITERATE_KIT_UNAVAILABLE;
    }

    if (completionReady_.load(
            std::memory_order_acquire) != 0U) {
      if (matches(
              completion_,
              command,
              generation,
              connected)) {
        const auto result = completionResult_;
        completionReady_.store(
            0U, std::memory_order_release);
        return result;
      }
      /*
       * Socket state can change again before an older fence is polled. Its
       * physical work is still useful (old DMA was stopped), but its result
       * cannot acknowledge a different {generation,connected} key. Discard
       * only the completion record; the next request may then occupy the same
       * single slot once pending_ observes the owner's release.
       */
      completionReady_.store(
          0U, std::memory_order_release);
    }

    request_ = {command, generation, connected};
    submittedAtMs_ = nowMs;
    pending_.store(1U, std::memory_order_release);
    return ITERATE_KIT_UNAVAILABLE;
  }

  bool take(Envelope *destination) {
    if (destination == nullptr || ownerClaimed_ ||
        pending_.load(std::memory_order_acquire) == 0U) {
      return false;
    }
    *destination = request_;
    ownerClaimed_ = true;
    return true;
  }

  void complete(iterate_kit_status result) {
    if (!ownerClaimed_) {
      return;
    }
    completion_ = request_;
    completionResult_ = result;
    ownerClaimed_ = false;
    /*
     * Publish the result before releasing the request slot. A producer which
     * arrives in the tiny interval between these stores can consume this exact
     * completion; a different key will still see pending_ and retry rather
     * than overwrite request_ while the owner is unwinding.
     */
    completionReady_.store(
        1U, std::memory_order_release);
    pending_.store(0U, std::memory_order_release);
  }

  void failClosed() {
    failed_ = true;
  }

  bool failed() const {
    return failed_;
  }

 private:
  static bool matches(
      const Envelope &envelope,
      Command command,
      std::uint32_t generation,
      bool connected) {
    return envelope.command == command &&
        envelope.generation == generation &&
        envelope.connected == connected;
  }

  Envelope request_{};
  Envelope completion_{};
  std::uint64_t submittedAtMs_ = 0U;
  iterate_kit_status completionResult_ =
      ITERATE_KIT_STATE_ERROR;
  std::atomic<std::uint32_t> pending_{0U};
  std::atomic<std::uint32_t> completionReady_{0U};
  bool ownerClaimed_ = false;
  bool failed_ = false;
};

/**
 * Owner wake policy for RealtimePlayback's partial-prebuffer timeout.
 *
 * RealtimePlayback owns the loss classification and destructive reset; this
 * tiny companion owns only scheduling. Once any content is retained while the
 * policy is still buffering, an infinite task wait is no longer legal because
 * no further frame/EOF callback is guaranteed to arrive. Re-observing the same
 * partial state never extends the original deadline—otherwise a slow trickle
 * could keep stale speech resident indefinitely.
 */
template<std::uint32_t TimeoutMs>
class PartialPrebufferWakeDeadline {
  static_assert(TimeoutMs > 0U);

 public:
  struct Wait {
    bool bounded;
    std::uint64_t remainingMs;
  };

  void observe(
      std::uint64_t nowMs,
      bool hasRetainedPartialPrebuffer) {
    if (!hasRetainedPartialPrebuffer) {
      armed_ = false;
      startedAtMs_ = 0U;
      return;
    }
    if (!armed_) {
      startedAtMs_ = nowMs;
      armed_ = true;
    }
  }

  Wait waitAt(std::uint64_t nowMs) const {
    if (!armed_) {
      return {false, 0U};
    }
    if (nowMs < startedAtMs_) {
      /*
       * Extending retention on a regressed clock would turn corrupted timing
       * evidence into permission to wait. Wake immediately and let the policy
       * classify/reset from its own monotonic checks.
       */
      return {true, 0U};
    }
    const auto elapsedMs = nowMs - startedAtMs_;
    return {
      true,
      elapsedMs >= TimeoutMs
          ? 0U
          : TimeoutMs - elapsedMs};
  }

 private:
  std::uint64_t startedAtMs_ = 0U;
  bool armed_ = false;
};

}  // namespace iterate::kit::platforms

#endif
