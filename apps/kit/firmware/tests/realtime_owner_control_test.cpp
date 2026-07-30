#include "iterate/kit/platforms/bounded_event_counter.hpp"
#include "iterate/kit/platforms/realtime_owner_control.hpp"

#include <cassert>
#include <cstdint>
#include <limits>

namespace {

using iterate::kit::platforms::SingleOwnerCommandMailbox;
using iterate::kit::platforms::PartialPrebufferWakeDeadline;
using iterate::kit::platforms::BoundedEventCounter;

enum class Command : std::uint8_t {
  begin,
  flushGeneration,
  suspend,
};

enum class GenerationFenceCommand : std::uint8_t {
  flushGeneration,
};

enum class LifecycleCommand : std::uint8_t {
  begin,
  suspend,
  resume,
  snapshotMetrics,
};

using Mailbox =
    SingleOwnerCommandMailbox<Command, 1'000U>;

struct CompleteAfterFirstStateObservation {
  static inline bool armed = false;

  template<typename MailboxType>
  static void afterFirstStateObservation(
      MailboxType &mailbox) {
    if (!armed) {
      return;
    }
    armed = false;
    mailbox.complete(ITERATE_KIT_OK);
  }
};

using InterleavedMailbox =
    SingleOwnerCommandMailbox<
        Command,
        1'000U,
        CompleteAfterFirstStateObservation>;

using GenerationFenceMailbox =
    SingleOwnerCommandMailbox<
        GenerationFenceCommand, 1'000U>;
using LifecycleMailbox =
    SingleOwnerCommandMailbox<
        LifecycleCommand, 1'000U>;

/*
 * The PCM transport polls its generation barrier from the application task.
 * Waiting there for the priority-19 audio owner would stall socket admission,
 * Cap'n Web, and diagnostics behind an I2S lifecycle operation. This scenario
 * proves the first request only publishes one fixed command and returns
 * UNAVAILABLE; the same key becomes successful only after the owner publishes
 * physical completion. There is no command FIFO in which reconnects can build
 * a stale lifecycle backlog.
 */
void generationFenceIsAConstantSpaceNonblockingPoll() {
  Mailbox mailbox;
  constexpr std::uint32_t generation = 17U;

  assert(
      mailbox.request(
          Command::flushGeneration,
          generation,
          true,
          100U) == ITERATE_KIT_UNAVAILABLE);

  Mailbox::Envelope envelope{};
  assert(mailbox.take(&envelope));
  assert(envelope.command == Command::flushGeneration);
  assert(envelope.generation == generation);
  assert(envelope.connected);
  assert(
      mailbox.request(
          Command::flushGeneration,
          generation,
          true,
          101U) == ITERATE_KIT_UNAVAILABLE);
  assert(!mailbox.take(&envelope));

  mailbox.complete(ITERATE_KIT_OK);
  assert(
      mailbox.request(
          Command::flushGeneration,
          generation,
          true,
          102U) == ITERATE_KIT_OK);
}

/*
 * Owner completion consists of two release publications: first its result,
 * then the now-idle request slot. If the producer checks result-ready first,
 * this exact interleaving can make it miss the result, observe the newly idle
 * slot, and publish a duplicate command. Its next poll then consumes the old
 * matching success while duplicate physical teardown is still pending—opening
 * socket admission without the barrier it supposedly acknowledged.
 *
 * The injected hook lands completion between the producer's first and second
 * state observations. This is deterministic because a statistical thread race
 * could pass for years while the unsafe ordering remains in firmware.
 */
void completionCannotBeAcknowledgedWhileDuplicateWorkRemains() {
  InterleavedMailbox mailbox;
  constexpr std::uint32_t generation = 29U;

  assert(
      mailbox.request(
          Command::flushGeneration,
          generation,
          true,
          500U) == ITERATE_KIT_UNAVAILABLE);
  InterleavedMailbox::Envelope envelope{};
  assert(mailbox.take(&envelope));

  CompleteAfterFirstStateObservation::armed = true;
  assert(
      mailbox.request(
          Command::flushGeneration,
          generation,
          true,
          501U) == ITERATE_KIT_UNAVAILABLE);
  assert(
      mailbox.request(
          Command::flushGeneration,
          generation,
          true,
          502U) == ITERATE_KIT_OK);

  /*
   * Returning OK is safe only if the exact completed command was consumed and
   * no second teardown was admitted behind it.
   */
  assert(!mailbox.take(&envelope));
}

/*
 * A metrics sample can arrive after the owner completed a reconnect fence but
 * before the transport polls that result. If both operations share one slot,
 * the different snapshot key discards the unconsumed fence completion; the
 * next transport poll then schedules a second physical I2S teardown. Separate
 * typed mailboxes make that overwrite structurally impossible: lifecycle work
 * completes independently, and the exact generation result remains available
 * without executing its command twice.
 */
void completedGenerationFenceSurvivesMetricsSnapshot() {
  GenerationFenceMailbox generationFence;
  LifecycleMailbox lifecycle;
  constexpr std::uint32_t generation = 41U;
  std::uint32_t physicalGenerationFlushes = 0U;

  assert(
      generationFence.request(
          GenerationFenceCommand::flushGeneration,
          generation,
          true,
          1'000U) == ITERATE_KIT_UNAVAILABLE);
  GenerationFenceMailbox::Envelope generationEnvelope{};
  assert(generationFence.take(&generationEnvelope));
  ++physicalGenerationFlushes;
  generationFence.complete(ITERATE_KIT_OK);

  assert(
      lifecycle.request(
          LifecycleCommand::snapshotMetrics,
          0U,
          false,
          1'001U) == ITERATE_KIT_UNAVAILABLE);
  LifecycleMailbox::Envelope lifecycleEnvelope{};
  assert(lifecycle.take(&lifecycleEnvelope));
  assert(
      lifecycleEnvelope.command ==
      LifecycleCommand::snapshotMetrics);
  lifecycle.complete(ITERATE_KIT_OK);
  assert(
      lifecycle.request(
          LifecycleCommand::snapshotMetrics,
          0U,
          false,
          1'002U) == ITERATE_KIT_OK);

  assert(
      generationFence.request(
          GenerationFenceCommand::flushGeneration,
          generation,
          true,
          1'003U) == ITERATE_KIT_OK);
  assert(!generationFence.take(&generationEnvelope));
  assert(physicalGenerationFlushes == 1U);
}

/*
 * Command-acknowledgement timeouts are lifetime diagnostics. Wrapping them to
 * zero during a long endurance run would turn a persistently unhealthy device
 * into an apparently clean one, so the target's two distinct counters use this
 * exact bounded primitive rather than ad-hoc `++` operations.
 */
void ownerTimeoutCounterSaturatesInsteadOfWrapping() {
  BoundedEventCounter counter;
  counter.add(
      std::numeric_limits<std::uint32_t>::max() - 1U);
  counter.record();
  assert(
      counter.value() ==
      std::numeric_limits<std::uint32_t>::max());
  counter.record();
  assert(
      counter.value() ==
      std::numeric_limits<std::uint32_t>::max());
}

/*
 * A high-priority owner should normally acknowledge in microseconds, but a
 * wedged I2C/driver path must not leave receive admission in CONNECTING
 * forever. The exact one-second boundary is deliberately worked from literal
 * times: before it the poll remains retryable; at it the mailbox latches a
 * visible hard failure and cannot later report a misleading late success.
 */
void unacknowledgedFenceFailsAtItsBoundedDeadline() {
  Mailbox mailbox;

  assert(
      mailbox.request(
          Command::flushGeneration,
          4U,
          false,
          8'000U) == ITERATE_KIT_UNAVAILABLE);
  assert(
      mailbox.request(
          Command::flushGeneration,
          4U,
          false,
          8'999U) == ITERATE_KIT_UNAVAILABLE);
  assert(
      mailbox.request(
          Command::flushGeneration,
          4U,
          false,
          9'000U) == ITERATE_KIT_IO_ERROR);

  Mailbox::Envelope envelope{};
  assert(mailbox.take(&envelope));
  mailbox.complete(ITERATE_KIT_OK);
  assert(
      mailbox.request(
          Command::flushGeneration,
          4U,
          false,
          9'001U) == ITERATE_KIT_IO_ERROR);
  assert(mailbox.failed());
}

/*
 * The policy only evaluates a partial-prebuffer timeout when pump() runs. If
 * one frame arrives and every producer wake then goes quiet, an owner waiting
 * forever for notifications retains that frame forever and can play stale
 * speech after a much later burst. The owner-side deadline starts with the
 * first retained frame, is not extended by later sub-threshold arrivals, and
 * becomes immediately due at 200 ms so the policy gets a chance to classify
 * and discard the exact partial incident.
 */
void oneFrameThenSilenceStillWakesAtPolicyDeadline() {
  PartialPrebufferWakeDeadline<200U> deadline;

  deadline.observe(3'000U, true);
  auto wait = deadline.waitAt(3'000U);
  assert(wait.bounded);
  assert(wait.remainingMs == 200U);

  deadline.observe(3'150U, true);
  wait = deadline.waitAt(3'150U);
  assert(wait.bounded);
  assert(wait.remainingMs == 50U);

  wait = deadline.waitAt(3'200U);
  assert(wait.bounded);
  assert(wait.remainingMs == 0U);

  deadline.observe(3'200U, false);
  wait = deadline.waitAt(3'201U);
  assert(!wait.bounded);
}

}  // namespace

int main() {
  generationFenceIsAConstantSpaceNonblockingPoll();
  completionCannotBeAcknowledgedWhileDuplicateWorkRemains();
  completedGenerationFenceSurvivesMetricsSnapshot();
  ownerTimeoutCounterSaturatesInsteadOfWrapping();
  unacknowledgedFenceFailsAtItsBoundedDeadline();
  oneFrameThenSilenceStillWakesAtPolicyDeadline();
  return 0;
}
