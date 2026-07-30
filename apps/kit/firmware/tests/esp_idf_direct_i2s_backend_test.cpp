#include "iterate/kit/platforms/direct_i2s_stereo_output.hpp"
#include "iterate/kit/platforms/esp_idf_direct_i2s_backend.hpp"

#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>

namespace {

constexpr std::size_t monoSampleCount = 320U;
constexpr std::size_t descriptorCount = 4U;
constexpr std::size_t stereoFrameBytes =
    monoSampleCount * 2U * sizeof(std::int16_t);
constexpr std::uint32_t frameDurationUs = 20'000U;

using iterate::kit::platforms::DirectI2sDescriptorToken;
using iterate::kit::platforms::DirectI2sStereoOutput;
using iterate::kit::platforms::DirectI2sStereoOutputFault;
using iterate::kit::platforms::DirectI2sStereoOutputState;
using iterate::kit::platforms::EspIdfDirectI2sIoResult;
using iterate::kit::platforms::EspIdfDirectI2sOverflowCallback;
using iterate::kit::platforms::EspIdfDirectI2sSentCallback;

enum class HardwareEvent : std::uint8_t {
  amplifierOff,
  i2sRelease,
  i2sCreate,
  codecConfigure,
  i2sPreload,
  i2sEnable,
  amplifierOn,
  i2sWrite,
};

struct HardwareLog {
  std::array<HardwareEvent, 64U> events{};
  std::size_t count = 0U;

  void append(HardwareEvent event) {
    assert(count < events.size());
    events[count++] = event;
  }

  void clear() { count = 0U; }
};

/*
 * The fake stops exactly at the public ESP-IDF seam. It deliberately does not
 * emulate an audio FIFO: preload copies while READY, write consumes the one
 * pointer ESP-IDF's private completed-descriptor queue would expose, and ISR
 * methods publish the real callback data. A friendlier fake with anonymous
 * credits would miss exact descriptor identity and private-queue overflow,
 * which are the ownership facts this backend must preserve.
 */
struct FakeI2sOps {
  HardwareLog *log = nullptr;
  EspIdfDirectI2sSentCallback sent = nullptr;
  EspIdfDirectI2sOverflowCallback overflow = nullptr;
  void *callbackContext = nullptr;
  std::array<EspIdfDirectI2sIoResult, 8U> writes{};
  std::array<DirectI2sDescriptorToken, 8U> observedWriteTokens{};
  std::size_t scriptedWriteCount = 0U;
  std::size_t nextScriptedWrite = 0U;
  std::size_t observedWriteCount = 0U;
  std::uint64_t nowUs = 0U;
  std::uint32_t writeDurationUs = 0U;
  mutable bool overflowOnNextClockRead = false;
  bool overflowDuringNextWrite = false;
  bool ownerWaiterBlocked = false;
  std::size_t ownerNotifications = 0U;
  iterate_kit_status releaseStatus = ITERATE_KIT_OK;
  std::size_t createCount = 0U;
  bool created = false;
  bool running = false;

  iterate_kit_status createAndConfigure(
      void *context,
      EspIdfDirectI2sSentCallback sentCallback,
      EspIdfDirectI2sOverflowCallback overflowCallback) {
    assert(!created);
    log->append(HardwareEvent::i2sCreate);
    callbackContext = context;
    sent = sentCallback;
    overflow = overflowCallback;
    created = true;
    ++createCount;
    return ITERATE_KIT_OK;
  }

  iterate_kit_status release() {
    log->append(HardwareEvent::i2sRelease);
    if (releaseStatus != ITERATE_KIT_OK) {
      /*
       * This is the exact awkward IDF state the test needs to preserve:
       * i2s_channel_disable() failed, i2s_del_channel() consequently refused
       * a RUNNING channel, and its registered ISR callback is still live.
       * A fake which always nulls callbacks on release failure would make it
       * impossible to catch software ownership being cleared underneath ISR.
       */
      return releaseStatus;
    }
    created = false;
    running = false;
    sent = nullptr;
    overflow = nullptr;
    callbackContext = nullptr;
    return ITERATE_KIT_OK;
  }

  EspIdfDirectI2sIoResult preload(
      const void *,
      std::size_t bytes) {
    assert(created);
    assert(!running);
    log->append(HardwareEvent::i2sPreload);
    return {ITERATE_KIT_OK, bytes};
  }

  iterate_kit_status enable() {
    assert(created);
    assert(!running);
    log->append(HardwareEvent::i2sEnable);
    running = true;
    return ITERATE_KIT_OK;
  }

  EspIdfDirectI2sIoResult write(
      const void *,
      std::size_t bytes,
      DirectI2sDescriptorToken token) {
    assert(created);
    assert(running);
    assert(observedWriteCount < observedWriteTokens.size());
    observedWriteTokens[observedWriteCount++] = token;
    log->append(HardwareEvent::i2sWrite);
    if (overflowDuringNextWrite) {
      overflowDuringNextWrite = false;
      emitPrivateQueueOverflow();
    }
    /*
     * Advancing the same injected monotonic clock inside this seam lets the
     * backend test distinguish owner-wakeup latency from the full driver-call
     * duration without sleeping or depending on host scheduler timing.
     */
    nowUs += writeDurationUs;
    if (nextScriptedWrite < scriptedWriteCount) {
      return writes[nextScriptedWrite++];
    }
    return {ITERATE_KIT_OK, bytes};
  }

  std::uint64_t monotonicMicroseconds() const {
    if (overflowOnNextClockRead) {
      /*
       * This hook puts the ISR at the most dangerous poll interleaving:
       * after the owner has observed "no overflow", but while it is draining
       * callback metadata. A fake that only injects between public calls
       * cannot prove the backend closes that ownership race.
       */
      overflowOnNextClockRead = false;
      assert(overflow != nullptr);
      (void)overflow(callbackContext);
    }
    return nowUs;
  }

  bool notifyOwnerFromIsr() {
    ++ownerNotifications;
    const auto unblockedHigherPriorityOwner =
        ownerWaiterBlocked;
    ownerWaiterBlocked = false;
    return unblockedHigherPriorityOwner;
  }

  bool emitSent(
      void *dmaBuffer,
      std::uint64_t eofAtUs,
      std::size_t bytes = stereoFrameBytes) {
    assert(sent != nullptr);
    return sent(
        callbackContext, dmaBuffer, bytes, eofAtUs);
  }

  bool emitPrivateQueueOverflow() {
    assert(overflow != nullptr);
    return overflow(callbackContext);
  }
};

struct FakeBoardOps {
  HardwareLog *log = nullptr;

  iterate_kit_status setAmplifierEnabled(bool enabled) {
    log->append(
        enabled
            ? HardwareEvent::amplifierOn
            : HardwareEvent::amplifierOff);
    return ITERATE_KIT_OK;
  }

  iterate_kit_status configureCodec() {
    log->append(HardwareEvent::codecConfigure);
    return ITERATE_KIT_OK;
  }
};

using Backend =
    iterate::kit::platforms::EspIdfDirectI2sBackend<
        descriptorCount,
        stereoFrameBytes,
        frameDurationUs,
        FakeI2sOps,
        FakeBoardOps>;
using Output =
    DirectI2sStereoOutput<
        monoSampleCount,
        descriptorCount,
        Backend>;

struct Fixture {
  HardwareLog log{};
  FakeI2sOps i2s{&log};
  FakeBoardOps board{&log};
  Backend backend{i2s, board};
  Output output{backend};
  std::array<std::int16_t, monoSampleCount> mono{};
  std::array<std::uint8_t, descriptorCount> dmaBuffers{};

  void preloadAndStart() {
    assert(output.resetForPlayback() == ITERATE_KIT_OK);
    for (std::size_t index = 0U;
         index < descriptorCount;
         ++index) {
      mono[0] = static_cast<std::int16_t>(index + 1U);
      assert(
          output.preloadMono(mono.data(), mono.size()) ==
          ITERATE_KIT_OK);
    }
    assert(output.start() == ITERATE_KIT_OK);
  }
};

void lifecycleKeepsAmplifierLowUntilPreparedDmaRuns() {
  Fixture fixture;
  fixture.preloadAndStart();

  /*
   * The amp is the last start action. Turning it on while the codec or an
   * uninitialized descriptor is visible is the physical source of pops and
   * boot garbage—not merely an untidy call order.
   */
  const std::array expected{
    HardwareEvent::amplifierOff,
    HardwareEvent::i2sRelease,
    HardwareEvent::i2sCreate,
    HardwareEvent::codecConfigure,
    HardwareEvent::i2sPreload,
    HardwareEvent::i2sPreload,
    HardwareEvent::i2sPreload,
    HardwareEvent::i2sPreload,
    HardwareEvent::i2sEnable,
    HardwareEvent::amplifierOn,
  };
  assert(fixture.log.count == expected.size());
  for (std::size_t index = 0U;
       index < expected.size();
       ++index) {
    assert(fixture.log.events[index] == expected[index]);
  }

  fixture.log.clear();
  assert(fixture.output.stopAndRelease() == ITERATE_KIT_OK);
  assert(fixture.log.count == 2U);
  assert(
      fixture.log.events[0] ==
      HardwareEvent::amplifierOff);
  assert(
      fixture.log.events[1] ==
      HardwareEvent::i2sRelease);
}

void callbackBatchReportsOldestLagAndExactReuseLead() {
  Fixture fixture;
  fixture.preloadAndStart();
  fixture.i2s.emitSent(
      &fixture.dmaBuffers[0], 20'000U);
  fixture.i2s.emitSent(
      &fixture.dmaBuffers[1], 40'000U);
  fixture.i2s.emitSent(
      &fixture.dmaBuffers[2], 60'000U);
  fixture.i2s.nowUs = 60'300U;

  const auto poll = fixture.output.pollCompletionBatch();
  assert(poll.status == ITERATE_KIT_OK);
  assert(poll.batch.newlyCompletedDescriptorCount == 3U);
  assert(poll.batch.pendingRefillDescriptorCount == 3U);
  assert(poll.batch.timingValid);
  /*
   * Reporting only the newest callback's 300 us delay would hide that
   * descriptor zero has already spent 40.3 ms waiting for this owner. IDF's
   * EOF callback observes the descriptor *after* it completed and DMA has
   * advanced, so only the other three 20 ms descriptors remain before the
   * completed one is reused. The deadline is therefore 60 ms, not the 80 ms
   * physical cycle length.
   */
  assert(poll.batch.oldestEofToOwnerUs == 40'300U);
  assert(poll.batch.earliestReuseLeadUs == 19'700U);
}

void completedDescriptorHasOnlyThreeFrameDurationsToReuse() {
  Fixture fixture;
  fixture.preloadAndStart();
  fixture.i2s.emitSent(
      &fixture.dmaBuffers[0], 20'000U);

  /*
   * This boundary is deliberately close enough to expose the old off-by-one
   * model. Counting the just-completed descriptor would claim another 20 ms
   * of safety and could overwrite memory while DMA is already reading it.
   */
  fixture.i2s.nowUs = 79'500U;
  auto poll = fixture.output.pollCompletionBatch();
  assert(poll.status == ITERATE_KIT_OK);
  assert(poll.batch.oldestEofToOwnerUs == 59'500U);
  assert(poll.batch.earliestReuseLeadUs == 500U);

  fixture.i2s.nowUs = 80'000U;
  poll = fixture.output.pollCompletionBatch();
  assert(poll.status == ITERATE_KIT_OK);
  assert(poll.batch.oldestEofToOwnerUs == 60'000U);
  assert(poll.batch.earliestReuseLeadUs == 0U);
}

void regressedOwnerClockCannotManufactureFullReuseLead() {
  Fixture fixture;
  fixture.preloadAndStart();
  fixture.i2s.emitSent(
      &fixture.dmaBuffers[0], 20'000U);
  fixture.i2s.nowUs = 19'999U;

  /*
   * Clamping a regressed clock to age zero would manufacture the maximum
   * 60 ms lead and authorize a copy using timing evidence we do not possess.
   * This is a clock/invariant fault, not ordinary jitter, so descriptor
   * ownership must stop before any write.
   */
  const auto poll = fixture.output.pollCompletionBatch();
  assert(poll.status == ITERATE_KIT_STATE_ERROR);
  assert(
      fixture.output.state() ==
      DirectI2sStereoOutputState::poisoned);
  assert(fixture.i2s.observedWriteCount == 0U);
}

void
zeroByteWriteAfterEofIsClassifiedOnceThenFailsClosed() {
  Fixture fixture;
  fixture.preloadAndStart();
  fixture.i2s.emitSent(
      &fixture.dmaBuffers[0], 20'000U);
  fixture.i2s.nowUs = 20'100U;
  const auto firstPoll =
      fixture.output.pollCompletionBatch();
  assert(firstPoll.status == ITERATE_KIT_OK);
  assert(
      fixture.output.pendingRefillDescriptorCount() == 1U);

  fixture.i2s.writes[0] =
      {ITERATE_KIT_BACKPRESSURE, 0U};
  fixture.i2s.scriptedWriteCount = 1U;

  /*
   * IDF does invoke on_sent before queueing the pointer, but both actions occur
   * in the same ISR. A notified task cannot run until the ISR has queued that
   * pointer and returned; the driver's binary writer semaphore is also free
   * because this backend has one owner. A timeout-zero write after an observed
   * EOF therefore cannot legitimately make zero progress. Treating it as
   * transient caused taskYIELD plus a 10 ms tick sleep—an audible jitter source
   * which also obscured the actual driver/ownership defect. The first result
   * remains BACKPRESSURE so policy can classify the incident before resetting;
   * the backend itself is already quarantined and cannot enter IDF again.
   */
  assert(
      fixture.output.writeMono(
          fixture.mono.data(), fixture.mono.size()) ==
      ITERATE_KIT_BACKPRESSURE);
  assert(
      fixture.output.state() ==
      DirectI2sStereoOutputState::running);
  assert(
      fixture.output.pendingRefillDescriptorCount() == 1U);
  assert(fixture.i2s.observedWriteCount == 1U);

  assert(
      fixture.output.writeMono(
          fixture.mono.data(), fixture.mono.size()) ==
      ITERATE_KIT_STATE_ERROR);
  assert(
      fixture.output.state() ==
      DirectI2sStereoOutputState::poisoned);
  assert(fixture.i2s.observedWriteCount == 1U);
}

void successfulWriteReportsThePostCopyRefillBoundary() {
  Fixture fixture;
  fixture.preloadAndStart();
  fixture.i2s.emitSent(
      &fixture.dmaBuffers[0], 20'000U);
  fixture.i2s.nowUs = 20'600U;
  assert(
      fixture.output.pollCompletionBatch().status ==
      ITERATE_KIT_OK);
  fixture.i2s.writeDurationUs = 125U;

  /*
   * The callback-to-owner sample above is 600 us, but continuity depends on
   * the later instant at which i2s_channel_write has copied all 1,280 bytes.
   * The resulting 725 us age leaves 59,275 us before this descriptor's
   * three-frame reuse window closes.
   */
  assert(
      fixture.output.writeMono(
          fixture.mono.data(), fixture.mono.size()) ==
      ITERATE_KIT_OK);
  const auto timing =
      fixture.output.lastSuccessfulRefillTiming();
  assert(timing.valid);
  assert(timing.eofToSuccessfulRefillUs == 725U);
  assert(timing.writeCallDurationUs == 125U);
  assert(
      timing.reuseLeadAtSuccessfulRefillUs ==
      59'275U);
}

void privateQueueOverflowPoisonsTheGeneration() {
  Fixture fixture;
  fixture.preloadAndStart();
  fixture.i2s.emitSent(
      &fixture.dmaBuffers[0], 20'000U);
  fixture.i2s.emitPrivateQueueOverflow();

  assert(fixture.output.takeQueueOverflows() == 1U);
  assert(
      fixture.output.state() ==
      DirectI2sStereoOutputState::poisoned);
}

void overflowDuringCompletionDrainFailsClosedBeforeWrite() {
  Fixture fixture;
  fixture.preloadAndStart();
  fixture.i2s.emitSent(
      &fixture.dmaBuffers[0], 20'000U);
  fixture.i2s.overflowOnNextClockRead = true;

  /*
   * IDF drops the oldest private completed-buffer pointer on overflow. Even
   * if our callback ring still contains a plausible completion, the next
   * public write could fill a different physical descriptor. The poll must
   * therefore become fatal if overflow changes anywhere inside its drain.
   */
  const auto poll = fixture.output.pollCompletionBatch();
  assert(poll.status == ITERATE_KIT_STATE_ERROR);
  assert(
      fixture.output.state() ==
      DirectI2sStereoOutputState::poisoned);
  assert(
      fixture.output.fault() ==
      DirectI2sStereoOutputFault::completionCapacity);
  assert(fixture.i2s.observedWriteCount == 0U);
  assert(fixture.output.takeQueueOverflows() == 1U);
}

void overflowInsideDriverWriteCannotAdvanceOwnership() {
  Fixture fixture;
  fixture.preloadAndStart();
  fixture.i2s.emitSent(
      &fixture.dmaBuffers[0], 20'000U);
  fixture.i2s.nowUs = 20'100U;
  assert(
      fixture.output.pollCompletionBatch().status ==
      ITERATE_KIT_OK);
  fixture.i2s.overflowDuringNextWrite = true;

  /*
   * A full byte count is not success when the private IDF queue overflowed
   * during the same call: its pointer identity is no longer authoritative.
   * Preserve that byte count so the wrapper classifies the transfer as
   * uncertain/partial and stops instead of continuing from a false token.
   */
  assert(
      fixture.output.writeMono(
          fixture.mono.data(), fixture.mono.size()) ==
      ITERATE_KIT_IO_ERROR);
  assert(
      fixture.output.state() ==
      DirectI2sStereoOutputState::poisoned);
  assert(
      fixture.output.fault() ==
      DirectI2sStereoOutputFault::partialTransfer);
  assert(
      fixture.output.pendingRefillDescriptorCount() ==
      1U);
  assert(fixture.output.takeQueueOverflows() == 1U);
}

void eofCallbackWakesOnlyWhenItActuallyUnblocksOwner() {
  Fixture fixture;
  fixture.preloadAndStart();
  fixture.i2s.ownerWaiterBlocked = true;

  /*
   * IDF uses the callback's bool to request an ISR yield. Returning true
   * unconditionally at 50 EOFs/second wastes CPU and still does not notify the
   * owner. One EOF must send exactly one notification, and the return value
   * must be the real "higher-priority waiter unblocked" fact.
   */
  assert(fixture.i2s.emitSent(
      &fixture.dmaBuffers[0], 20'000U));
  assert(fixture.i2s.ownerNotifications == 1U);
  assert(!fixture.i2s.emitSent(
      &fixture.dmaBuffers[1], 40'000U));
  assert(fixture.i2s.ownerNotifications == 2U);
}

void failedReleaseQuarantinesLiveCallbackUntilDeletionSucceeds() {
  Fixture fixture;
  fixture.preloadAndStart();
  for (std::size_t index = 0U;
       index < descriptorCount;
       ++index) {
    assert(
        !fixture.i2s.emitSent(
            &fixture.dmaBuffers[index],
            (index + 1U) * frameDurationUs));
  }
  fixture.i2s.releaseStatus = ITERATE_KIT_IO_ERROR;

  /*
   * IDF does not promise that a failed delete unregisters callbacks. In
   * particular, a failed disable can leave the channel RUNNING and make
   * i2s_del_channel() reject it. The backend must therefore retain every
   * callback-owned ledger entry and refuse to create a replacement channel;
   * clearing dmaBuffers_/callbackSequence_ while this callback executes is a
   * real task/ISR data race, not merely stale diagnostics.
   */
  assert(
      fixture.output.stopAndRelease() ==
      ITERATE_KIT_IO_ERROR);
  assert(fixture.i2s.created);
  assert(fixture.i2s.createCount == 1U);
  assert(
      !fixture.i2s.emitSent(
          &fixture.dmaBuffers[0], 100'000U));
  /*
   * Four unconsumed callback records preceded teardown. The still-live fifth
   * callback must see that retained full ring and classify overflow. A local
   * reset under the ISR would instead make this look like the first pristine
   * callback of a new generation.
   */
  assert(fixture.output.takeQueueOverflows() == 1U);

  /*
   * A reset retries physical deletion first. It must not call create while
   * deletion remains unproven; once the same handle is actually gone, it may
   * clear the quarantined ledger and create exactly one fresh generation.
   */
  assert(
      fixture.output.resetForPlayback() ==
      ITERATE_KIT_IO_ERROR);
  assert(fixture.i2s.createCount == 1U);
  assert(
      !fixture.i2s.emitSent(
          &fixture.dmaBuffers[1], 120'000U));

  fixture.i2s.releaseStatus = ITERATE_KIT_OK;
  assert(
      fixture.output.resetForPlayback() ==
      ITERATE_KIT_OK);
  assert(fixture.i2s.createCount == 2U);
}

}  // namespace

int main() {
  lifecycleKeepsAmplifierLowUntilPreparedDmaRuns();
  callbackBatchReportsOldestLagAndExactReuseLead();
  completedDescriptorHasOnlyThreeFrameDurationsToReuse();
  regressedOwnerClockCannotManufactureFullReuseLead();
  zeroByteWriteAfterEofIsClassifiedOnceThenFailsClosed();
  successfulWriteReportsThePostCopyRefillBoundary();
  privateQueueOverflowPoisonsTheGeneration();
  overflowDuringCompletionDrainFailsClosedBeforeWrite();
  overflowInsideDriverWriteCannotAdvanceOwnership();
  eofCallbackWakesOnlyWhenItActuallyUnblocksOwner();
  failedReleaseQuarantinesLiveCallbackUntilDeletionSucceeds();
  return 0;
}
