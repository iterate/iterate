#include "iterate/kit/platforms/realtime_playback.hpp"
#include "iterate/kit/platforms/m5sticks3_realtime_audio_policy.hpp"

#include "iterate/kit/pcm_lane.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

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

constexpr std::size_t sampleCount =
    ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME;
/*
 * The Stick owns a 32-frame / 640 ms application downlink ring. The old
 * eight-slot host fixture accidentally made it impossible to preload the
 * target's now-larger physical descriptor cycle and therefore tested a
 * topology the device cannot have. Matching the production ring keeps fault
 * scenarios free to exercise DMA policy; individual tests still publish only
 * the frames their invariant needs, so this adds no hidden playback queue.
 */
constexpr std::size_t laneSlotCount = 32U;
constexpr std::uint32_t sampleRate =
    ITERATE_KIT_PCM_V1_SAMPLE_RATE_HZ;
constexpr std::uint32_t frameDurationMs =
    static_cast<std::uint32_t>(
        sampleCount * 1000U / sampleRate);
constexpr std::uint32_t maximumFrameAgeMs = 200U;
constexpr std::uint32_t partialPrebufferTimeoutMs = 200U;
constexpr std::uint32_t minimumRefillLeadUs = 2'000U;

struct LaneFixture {
  iterate_kit_spsc_ring uplinkRing{};
  iterate_kit_spsc_ring downlinkRing{};
  iterate_kit_pcm_uplink_slot uplinkStorage[laneSlotCount]{};
  iterate_kit_pcm_downlink_slot downlinkStorage[laneSlotCount]{};
  std::size_t uplinkLengths[laneSlotCount]{};
  std::size_t downlinkLengths[laneSlotCount]{};
  iterate_kit_pcm_lane lane{};

  LaneFixture() {
    TEST_ASSERT(
        iterate_kit_spsc_ring_init(
            &uplinkRing,
            uplinkStorage,
            sizeof(uplinkStorage[0]),
            laneSlotCount,
            uplinkLengths) == ITERATE_KIT_OK);
    TEST_ASSERT(
        iterate_kit_spsc_ring_init(
            &downlinkRing,
            downlinkStorage,
            sizeof(downlinkStorage[0]),
            laneSlotCount,
            downlinkLengths) == ITERATE_KIT_OK);
    TEST_ASSERT(
        iterate_kit_pcm_lane_init(
            &lane, &uplinkRing, &downlinkRing) ==
        ITERATE_KIT_OK);
  }

  void publish(
      std::int16_t value,
      std::uint64_t receivedAtMs) {
    std::array<std::int16_t, sampleCount> frame{};
    frame.fill(value);
    TEST_ASSERT(
        iterate_kit_pcm_lane_receive_downlink_at(
            &lane,
            ITERATE_KIT_PCM_MESSAGE_BINARY,
            true,
            sizeof(frame),
            0U,
            frame.data(),
            sizeof(frame),
            receivedAtMs) == ITERATE_KIT_OK);
  }

  void publishEnd(std::uint64_t receivedAtMs) {
    TEST_ASSERT(
        iterate_kit_pcm_lane_receive_downlink_at(
            &lane,
            ITERATE_KIT_PCM_MESSAGE_BINARY,
            true,
            0U,
            0U,
            nullptr,
            0U,
            receivedAtMs) == ITERATE_KIT_OK);
  }
};

template<std::size_t DescriptorCount>
struct FakeDirectOutputFor {
  using FrameMetadata =
      iterate::kit::platforms::
          RealtimePlaybackFrameMetadata;
  using FrameKind =
      iterate::kit::platforms::
          RealtimePlaybackFrameKind;
  using Completion =
      iterate::kit::platforms::
          RealtimePlaybackDescriptorCompletion;
  using RefillTiming =
      iterate::kit::platforms::
          RealtimePlaybackSuccessfulRefillTiming;

  std::vector<std::int16_t> currentDma;
  std::vector<FrameMetadata> currentMetadata;
  std::vector<FrameKind> currentKinds;
  std::vector<std::int16_t> attemptedWrites;
  std::vector<std::int16_t> submittedHistory;
  std::vector<FrameMetadata> submittedMetadataHistory;
  std::vector<Completion> unpolledCompletions;
  std::vector<Completion> lastCompletions;
  std::uint32_t resetCount = 0U;
  std::uint32_t startCount = 0U;
  std::uint32_t stopCount = 0U;
  std::uint32_t queueOverflowsSinceTake = 0U;
  std::uint32_t oldestEofToOwnerUs = 0U;
  std::uint32_t nextEofLeadUs = 20'000U;
  RefillTiming nextRefillTiming{
    true, 250U, 50U, 59'750U};
  std::uint64_t nextEofAtUs = 20'000U;
  iterate_kit_status nextPreloadStatus = ITERATE_KIT_OK;
  iterate_kit_status nextWriteStatus = ITERATE_KIT_OK;
  iterate_kit_status nextPollStatus = ITERATE_KIT_OK;
  iterate_kit_status nextStopStatus = ITERATE_KIT_OK;
  std::uint32_t reportedPendingOverride = 0U;
  std::uint32_t runningSilenceWrites = 0U;
  bool useReportedPendingOverride = false;
  bool rejectPollWhileStopped = false;
  bool overflowDuringNextPoll = false;
  bool enforceBoundedDriverQueue = false;
  iterate_kit_spsc_ring *invalidateRingDuringNextPreload =
      nullptr;
  iterate_kit_spsc_ring *invalidateRingDuringNextWrite =
      nullptr;
  std::size_t writeCredits = 0U;
  bool running = false;

  iterate_kit_status resetForPlayback() {
    resetCount += 1U;
    currentDma.clear();
    currentMetadata.clear();
    currentKinds.clear();
    unpolledCompletions.clear();
    lastCompletions.clear();
    queueOverflowsSinceTake = 0U;
    writeCredits = 0U;
    running = false;
    return ITERATE_KIT_OK;
  }

  iterate_kit_status preloadMono(
      const std::int16_t *samples,
      std::size_t count) {
    return preloadMono(
        samples, count, FrameMetadata{});
  }

  iterate_kit_status preloadMono(
      const std::int16_t *samples,
      std::size_t count,
      FrameMetadata metadata) {
    TEST_ASSERT(!running);
    TEST_ASSERT(samples != nullptr);
    TEST_ASSERT(count == sampleCount);
    if (nextPreloadStatus != ITERATE_KIT_OK) {
      const auto status = nextPreloadStatus;
      nextPreloadStatus = ITERATE_KIT_OK;
      return status;
    }
    if (currentDma.size() >= DescriptorCount) {
      return ITERATE_KIT_BACKPRESSURE;
    }
    currentDma.push_back(samples[0]);
    currentMetadata.push_back(metadata);
    currentKinds.push_back(FrameKind::content);
    submittedHistory.push_back(samples[0]);
    submittedMetadataHistory.push_back(metadata);
    if (invalidateRingDuringNextPreload != nullptr) {
      invalidateRingDuringNextPreload->initialized = false;
      invalidateRingDuringNextPreload = nullptr;
    }
    return ITERATE_KIT_OK;
  }

  iterate_kit_status preloadSilence() {
    TEST_ASSERT(!running);
    if (currentDma.size() >= DescriptorCount) {
      return ITERATE_KIT_BACKPRESSURE;
    }
    /*
     * Padding is a DMA-initialization obligation, not delivered speech. Keep it
     * in the cyclic descriptor model but out of submittedHistory so exact
     * content accounting cannot accidentally count silence as a server frame.
    */
    currentDma.push_back(0);
    currentMetadata.push_back(FrameMetadata{});
    currentKinds.push_back(FrameKind::paddingSilence);
    return ITERATE_KIT_OK;
  }

  iterate_kit_status start() {
    TEST_ASSERT(currentDma.size() == DescriptorCount);
    TEST_ASSERT(!running);
    startCount += 1U;
    running = true;
    return ITERATE_KIT_OK;
  }

  iterate_kit_status writeMono(
      const std::int16_t *samples,
      std::size_t count) {
    return writeMono(
        samples, count, FrameMetadata{});
  }

  iterate_kit_status writeMono(
      const std::int16_t *samples,
      std::size_t count,
      FrameMetadata metadata) {
    TEST_ASSERT(running);
    TEST_ASSERT(samples != nullptr);
    TEST_ASSERT(count == sampleCount);
    attemptedWrites.push_back(samples[0]);
    if (nextWriteStatus != ITERATE_KIT_OK) {
      const auto status = nextWriteStatus;
      nextWriteStatus = ITERATE_KIT_OK;
      return status;
    }
    if (writeCredits == 0U) {
      return ITERATE_KIT_BACKPRESSURE;
    }
    writeCredits -= 1U;
    currentDma.push_back(samples[0]);
    currentMetadata.push_back(metadata);
    currentKinds.push_back(FrameKind::content);
    submittedHistory.push_back(samples[0]);
    submittedMetadataHistory.push_back(metadata);
    if (invalidateRingDuringNextWrite != nullptr) {
      invalidateRingDuringNextWrite->initialized = false;
      invalidateRingDuringNextWrite = nullptr;
    }
    return ITERATE_KIT_OK;
  }

  iterate_kit_status writeSilence() {
    TEST_ASSERT(running);
    if (writeCredits == 0U) {
      return ITERATE_KIT_BACKPRESSURE;
    }
    --writeCredits;
    currentDma.push_back(0);
    currentMetadata.push_back(FrameMetadata{});
    currentKinds.push_back(FrameKind::paddingSilence);
    ++runningSilenceWrites;
    return ITERATE_KIT_OK;
  }

  iterate_kit_status writeRecoverySilence() {
    TEST_ASSERT(running);
    if (writeCredits == 0U) {
      return ITERATE_KIT_BACKPRESSURE;
    }
    --writeCredits;
    currentDma.push_back(0);
    currentMetadata.push_back(FrameMetadata{});
    currentKinds.push_back(FrameKind::recoverySilence);
    ++runningSilenceWrites;
    return ITERATE_KIT_OK;
  }

  iterate_kit_status stopAndRelease() {
    stopCount += 1U;
    if (nextStopStatus != ITERATE_KIT_OK) {
      const auto status = nextStopStatus;
      nextStopStatus = ITERATE_KIT_OK;
      return status;
    }
    currentDma.clear();
    currentMetadata.clear();
    currentKinds.clear();
    unpolledCompletions.clear();
    lastCompletions.clear();
    queueOverflowsSinceTake = 0U;
    writeCredits = 0U;
    running = false;
    return ITERATE_KIT_OK;
  }

  iterate::kit::platforms::
      RealtimePlaybackCompletionPollResult
  pollCompletionBatch() {
    if (rejectPollWhileStopped && !running) {
      return {
        ITERATE_KIT_STATE_ERROR,
        iterate::kit::platforms::
            RealtimePlaybackCompletionBatch{}};
    }
    if (nextPollStatus != ITERATE_KIT_OK) {
      const auto status = nextPollStatus;
      nextPollStatus = ITERATE_KIT_OK;
      return {
        status,
        iterate::kit::platforms::
            RealtimePlaybackCompletionBatch{}};
    }
    lastCompletions = unpolledCompletions;
    unpolledCompletions.clear();
    if (overflowDuringNextPoll) {
      /*
       * This hook models an ISR preempting the owner after its initial
       * overflow check but before completion polling returns. It deliberately
       * happens after the batch has been copied so a one-check policy would
       * trust the batch and issue a write against corrupted IDF queue order.
       */
      queueOverflowsSinceTake += 1U;
      overflowDuringNextPoll = false;
    }
    const auto batch =
        iterate::kit::platforms::RealtimePlaybackCompletionBatch{
          .newlyCompletedDescriptorCount =
              static_cast<std::uint32_t>(
                  lastCompletions.size()),
          .pendingRefillDescriptorCount =
              useReportedPendingOverride
              ? reportedPendingOverride
              : static_cast<std::uint32_t>(writeCredits),
          .timingValid = writeCredits > 0U,
          .oldestEofToOwnerUs = oldestEofToOwnerUs,
          .earliestReuseLeadUs = nextEofLeadUs,
        };
    oldestEofToOwnerUs = 0U;
    nextEofLeadUs = 20'000U;
    useReportedPendingOverride = false;
    return {ITERATE_KIT_OK, batch};
  }

  bool lastPlaybackCompletion(
      std::size_t index,
      Completion *completion) const {
    if (completion == nullptr ||
        index >= lastCompletions.size()) {
      return false;
    }
    *completion = lastCompletions[index];
    return true;
  }

  std::uint32_t takeQueueOverflows() {
    const auto overflows = queueOverflowsSinceTake;
    queueOverflowsSinceTake = 0U;
    return overflows;
  }

  RefillTiming lastSuccessfulRefillTiming() const {
    return nextRefillTiming;
  }

  void complete(std::size_t count) {
    TEST_ASSERT(running);
    TEST_ASSERT(count <= currentDma.size());
    TEST_ASSERT(count <= currentMetadata.size());
    TEST_ASSERT(count <= currentKinds.size());
    for (std::size_t index = 0U;
         index < count;
         ++index) {
      unpolledCompletions.push_back(
          Completion{
            nextEofAtUs,
            currentMetadata[index],
            currentKinds[index]});
      nextEofAtUs += 20'000U;
      /*
       * ESP-IDF's public TX path stores completed DMA pointers in a queue with
       * `dma_desc_num - 1` entries. The original fake had an unbounded credit
       * counter, which made every finite-stream test structurally incapable of
       * reproducing the physical Stick failure: after EOS, four unconsumed
       * pointers filled a three-entry queue, IDF dropped the oldest, and the
       * firmware reported exactly 250 submitted / 249 completed / one flushed.
       *
       * Most policy tests intentionally use a simpler unconstrained fake.
       * Enable the real capacity only where queue consumption itself is the
       * contract under test, rather than making unrelated deadline tests
       * inherit a second failure mechanism.
       */
      if (enforceBoundedDriverQueue &&
          writeCredits >= DescriptorCount - 1U) {
        ++queueOverflowsSinceTake;
      } else {
        ++writeCredits;
      }
    }
    currentDma.erase(
        currentDma.begin(),
        currentDma.begin() +
            static_cast<std::ptrdiff_t>(count));
    currentMetadata.erase(
        currentMetadata.begin(),
        currentMetadata.begin() +
            static_cast<std::ptrdiff_t>(count));
    currentKinds.erase(
        currentKinds.begin(),
        currentKinds.begin() +
            static_cast<std::ptrdiff_t>(count));
  }
};

using FakeDirectOutput = FakeDirectOutputFor<4U>;

constexpr std::size_t m5StickS3ProductionDescriptorCount =
    iterate::kit::platforms::M5StickS3RealtimeAudioPolicy::
        descriptorCount;
using M5StickS3ProductionFakeDirectOutput =
    FakeDirectOutputFor<m5StickS3ProductionDescriptorCount>;

using Playback =
    iterate::kit::platforms::RealtimePlayback<
        sampleCount,
        sampleRate,
        4U,
        maximumFrameAgeMs,
        partialPrebufferTimeoutMs,
        minimumRefillLeadUs>;

using M5StickS3ProductionPlayback =
    iterate::kit::platforms::RealtimePlayback<
        sampleCount,
        sampleRate,
        m5StickS3ProductionDescriptorCount,
        iterate::kit::platforms::M5StickS3RealtimeAudioPolicy::
            maximumFrameAgeMs,
        iterate::kit::platforms::M5StickS3RealtimeAudioPolicy::
            partialPrebufferTimeoutMs,
        iterate::kit::platforms::M5StickS3RealtimeAudioPolicy::
            minimumRefillLeadUs>;

/*
 * The policy owns counters and scalar ownership metadata, never PCM storage.
 * Pinning the measured 296-byte 64-bit-host ceiling catches an accidental frame
 * copy/vector/queue in this layer. The latest 24 bytes are deliberate: four
 * counters expose submitted/completed/retired/drop dispositions, while two
 * scalar ledgers retain exact ordered-drop and outstanding-descriptor
 * ownership without retaining PCM. The object is still hundreds of bytes
 * rather than even one 640-byte mono frame. Target resource reports remain the
 * authoritative ESP32 size.
 */
static_assert(
    sizeof(Playback) <= 304U,
    "realtime playback policy must remain a small control object");

/*
 * Direct I2S begins cycling every descriptor as soon as it is enabled. Starting
 * after one frame makes the other descriptors repeat zero or stale heap data,
 * while growing a software FIFO hides network delay. This pins the chosen
 * middle ground: exactly four fresh 20 ms content frames overwrite all four
 * descriptors before clocks and the amplifier start.
 */
void fourFreshFramesAreRequiredBeforePlaybackStarts() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);

  for (std::int16_t value = 1; value <= 3; ++value) {
    fixture.publish(value, static_cast<std::uint64_t>(value * 20));
    const auto result =
        playback.pump(fixture.lane, output, value * 20U);
    TEST_ASSERT(result.status == ITERATE_KIT_OK);
    TEST_ASSERT(!result.playbackStarted);
    TEST_ASSERT(output.startCount == 0U);
  }
  fixture.publish(4, 80U);
  const auto result = playback.pump(fixture.lane, output, 80U);
  TEST_ASSERT(result.status == ITERATE_KIT_OK);
  TEST_ASSERT(result.playbackStarted);
  TEST_ASSERT(output.startCount == 1U);
  TEST_ASSERT(
      output.currentDma ==
      std::vector<std::int16_t>({1, 2, 3, 4}));
  TEST_ASSERT(playback.metrics().currentContentFrames == 4U);
}

/*
 * Wi-Fi and the JavaScript proxy deliver frames with ordinary scheduler jitter
 * even when their mean rate is correct. A four-descriptor reserve should absorb
 * those variations without stopping, repeating, or reordering audio. The fake
 * DMA clock is independent of producer calls so this proves the policy rather
 * than a lockstep test artifact.
 */
void boundedJitterPlaysOneOrderedContinuousSequence() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 60U).playbackStarted);

  std::uint64_t nowMs = 80U;
  for (std::int16_t value = 5; value <= 104; ++value) {
    /*
     * Alternating early/late delivery changes queue depth without exceeding
     * the 80 ms reserve. A design that submits only from a 10 ms application
     * poll or mistakes notifications for frame counts eventually underruns.
     */
    nowMs += value % 3 == 0 ? 27U : 17U;
    fixture.publish(value, nowMs);
    output.complete(1U);
    const auto result =
        playback.pump(fixture.lane, output, nowMs);
    TEST_ASSERT(result.status == ITERATE_KIT_OK);
    TEST_ASSERT(!result.playbackStarted);
  }

  TEST_ASSERT(output.resetCount == 1U);
  TEST_ASSERT(output.startCount == 1U);
  TEST_ASSERT(playback.metrics().underrunIncidents == 0U);
  TEST_ASSERT(playback.metrics().dmaFramesSubmitted == 104U);
  for (std::size_t index = 0U;
       index < output.submittedHistory.size();
       ++index) {
    TEST_ASSERT(
        output.submittedHistory[index] ==
        static_cast<std::int16_t>(index + 1U));
  }
}

/*
 * The direct-LAN Stick proof exposed a phase race between two valid clocks:
 * the host sends one frame every 20 ms while I2S completes one descriptor
 * every 20 ms. A frame arriving a few milliseconds after EOF is not late for
 * playback—the completed descriptor still has the other three 20 ms
 * descriptors before DMA reuses it. The old policy immediately filled that
 * descriptor with silence, discarded the subsequently arriving content, and
 * turned harmless network/timer phase into audible jiggle.
 *
 * Retain exact descriptor ownership while there is measured reuse lead, let
 * the producer notification wake the owner, and refill the same descriptor.
 * This is bounded by the driver's three-entry completed-pointer capacity and
 * its reuse deadline; it is not permission to queue stale speech.
 */
void timelyFrameAfterEofUsesHardwareReserveWithoutSilence() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);

  output.complete(1U);
  output.nextEofLeadUs = 59'500U;
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 20U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(output.running);
  TEST_ASSERT(output.runningSilenceWrites == 0U);
  TEST_ASSERT(playback.metrics().underrunIncidents == 0U);

  fixture.publish(5, 25U);
  output.nextEofLeadUs = 54'500U;
  output.nextRefillTiming = {
    true, 5'500U, 100U, 54'500U};
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 25U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(
      output.submittedHistory ==
      std::vector<std::int16_t>({1, 2, 3, 4, 5}));
  TEST_ASSERT(output.runningSilenceWrites == 0U);
  TEST_ASSERT(playback.metrics().underrunIncidents == 0U);
}

/*
 * If the producer genuinely stalls for the complete DMA reserve, replaying old
 * descriptors produces the audible jiggle heard in the first device proof.
 * Recovery must be one classified stop/reset, remain quiet while fewer than
 * four new frames exist, then restart exactly once from a fully overwritten
 * generation. Empty polls must not turn one incident into an error storm.
 */
void underrunStopsOnceAndRebuffersFourFreshFrames() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(playback.pump(fixture.lane, output, 0U).playbackStarted);

  output.complete(4U);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 80U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(playback.metrics().underrunIncidents == 1U);
  TEST_ASSERT(output.stopCount == 1U);
  TEST_ASSERT(output.resetCount == 2U);
  for (std::uint64_t nowMs = 81U; nowMs < 100U; ++nowMs) {
    TEST_ASSERT(
        playback.pump(fixture.lane, output, nowMs).status ==
        ITERATE_KIT_OK);
  }
  TEST_ASSERT(playback.metrics().underrunIncidents == 1U);

  for (std::int16_t value = 101; value <= 103; ++value) {
    fixture.publish(value, 100U);
  }
  TEST_ASSERT(
      !playback.pump(fixture.lane, output, 100U).playbackStarted);
  TEST_ASSERT(output.startCount == 1U);
  fixture.publish(104, 120U);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 120U).playbackStarted);
  TEST_ASSERT(output.startCount == 2U);
  TEST_ASSERT(
      output.currentDma ==
      std::vector<std::int16_t>({101, 102, 103, 104}));
}

/*
 * A public WebSocket can genuinely miss a physical playout slot even when it
 * later recovers. Once three completed descriptors are pending, retaining all
 * of them until the fourth EOF would overflow ESP-IDF's private finished
 * pointer queue. Tearing the whole I2S generation down instead turns one lost
 * slot into roughly another four-frame startup gap.
 *
 * The bounded recovery is one explicit silence descriptor. WebSocket/TCP is
 * ordered, so the first frame that subsequently arrives is the frame whose
 * slot was replaced by silence and must be discarded rather than played late.
 * The following on-time frame can then refill the next descriptor while the
 * same hardware generation keeps running. This is the smallest case that
 * distinguishes realtime recovery from both backlog accumulation and
 * destructive reset.
 */
void oneLateFrameUsesBoundedSilenceAndResumesWithoutReset() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);

  output.complete(3U);
  output.nextEofLeadUs = 20'000U;
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 60U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(output.running);
  TEST_ASSERT(output.runningSilenceWrites == 1U);
  TEST_ASSERT(output.stopCount == 0U);
  TEST_ASSERT(output.resetCount == 1U);
  TEST_ASSERT(playback.metrics().underrunIncidents == 1U);

  fixture.publish(5, 65U);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 65U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(
      output.submittedHistory ==
      std::vector<std::int16_t>({1, 2, 3, 4}));

  fixture.publish(6, 80U);
  output.complete(1U);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 80U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(
      output.submittedHistory ==
      std::vector<std::int16_t>({1, 2, 3, 4, 6}));
  TEST_ASSERT(output.running);
  TEST_ASSERT(output.stopCount == 0U);
  TEST_ASSERT(playback.metrics().underrunIncidents == 1U);
  TEST_ASSERT(
      playback.metrics().underrunSilenceFramesSubmitted ==
      1U);
  TEST_ASSERT(
      playback.metrics().underrunLateFramesDropped == 1U);

  /*
   * Frames seven and eight arrive while exact completed descriptors remain
   * owned by the task. Refill those slots on producer wakes; waiting for
   * another EOF before using already-owned descriptors would needlessly spend
   * the reserve and could reach the queue-capacity boundary again.
   */
  fixture.publish(7, 90U);
  output.nextEofLeadUs = 30'000U;
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 90U).status ==
      ITERATE_KIT_OK);
  fixture.publish(8, 100U);
  output.complete(1U);
  output.nextEofLeadUs = 20'000U;
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 100U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(
      output.submittedHistory ==
      std::vector<std::int16_t>(
          {1, 2, 3, 4, 6, 7, 8}));
  TEST_ASSERT(
      playback.metrics().underrunSilenceFramesCompleted ==
      1U);
  TEST_ASSERT(output.stopCount == 0U);
}

/*
 * Userspace deliberately discards elapsed audio after an event-loop or socket
 * egress stall so the conversation returns to realtime. The device cannot see
 * that upstream discard: if it keeps manufacturing one recovery silence and
 * one ordered drop debt per empty playout slot forever, newly-current frames
 * arrive only fast enough to pay old debt and the rest of the response remains
 * silent. This is worse than one bounded gap and was identified by composing
 * the userspace pacer with the firmware policy rather than testing either in
 * isolation.
 *
 * Permit two DMA cycles of cheap in-place recovery. The ninth missing slot
 * must reset and rebuffer the same generation, clearing scalar debt without
 * closing /pcm. Four later fresh frames then restart normally rather than
 * being consumed forever as stale heads.
 */
void prolongedRecoveryDebtResetsAndRebuffersFreshAudio() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);

  output.complete(3U);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 60U).status ==
      ITERATE_KIT_OK);
  for (std::uint64_t missingSlot = 2U;
       missingSlot <= 8U;
       ++missingSlot) {
    output.complete(1U);
    TEST_ASSERT(
        playback.pump(
            fixture.lane,
            output,
            40U + missingSlot * frameDurationMs).status ==
        ITERATE_KIT_OK);
  }
  TEST_ASSERT(output.running);
  TEST_ASSERT(
      playback.metrics().underrunSilenceFramesSubmitted ==
      8U);

  output.complete(1U);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 220U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(!output.running);
  TEST_ASSERT(output.stopCount == 1U);
  TEST_ASSERT(output.resetCount == 2U);
  TEST_ASSERT(
      playback.metrics().underrunSilenceFramesSubmitted ==
      8U);

  for (std::int16_t value = 101; value <= 104; ++value) {
    fixture.publish(value, 240U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 240U).
          playbackStarted);
  TEST_ASSERT(
      output.currentDma ==
      std::vector<std::int16_t>({101, 102, 103, 104}));
}

/*
 * Silence debt describes missing ordered PCM only until the ordered EOS marker
 * proves the response has no more content. Treating EOS as another late frame
 * would discard the boundary, keep manufacturing silence forever, and then
 * consume the beginning of the next response as stale audio. The marker must
 * instead close the debt and let the exact content tail drain normally.
 */
void endOfStreamClosesUnpayableRecoveryDebt() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);

  /*
   * Recovery begins only when the third unfilled completion reaches the
   * driver's bounded pointer capacity. A single post-EOF delay is still
   * ordinary jitter and must remain eligible for a content refill.
   */
  output.complete(3U);
  output.nextEofLeadUs = 20'000U;
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 60U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(
      playback.metrics().underrunSilenceFramesSubmitted ==
      1U);

  fixture.publishEnd(65U);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 65U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(
      playback.metrics().endOfStreamMarkersConsumed ==
      1U);
  TEST_ASSERT(
      playback.metrics().underrunLateFramesDropped == 0U);

  for (std::uint64_t nowMs = 80U;
       output.running && nowMs <= 140U;
       nowMs += 20U) {
    output.complete(1U);
    TEST_ASSERT(
        playback.pump(
            fixture.lane, output, nowMs).status ==
        ITERATE_KIT_OK);
  }
  TEST_ASSERT(!output.running);
  TEST_ASSERT(
      playback.metrics().endOfStreamResponses == 1U);
  TEST_ASSERT(playback.metrics().underrunIncidents == 1U);
}

/*
 * The July 30 two-second Stick trace ended with 44 recovery descriptors
 * submitted but only 43 EOF completions. That is not a missing callback:
 * ordered EOS arrived after the late content corresponding to the final
 * recovery slot had been dropped, and the final real content descriptor
 * completed before that trailing silence reached EOF. Stopping immediately at
 * the last content EOF is the correct low-latency acoustic behavior; waiting
 * another 20 ms merely to make a diagnostic counter advance would add an
 * artificial silent tail.
 *
 * The ownership nevertheless needs an exact terminal disposition. This
 * regression keeps the recovery descriptor behind the final content and
 * requires clean EOS teardown to classify it as retired, distinct from both
 * physical completion and unexplained loss. Conservation must therefore be:
 *
 *   submitted recovery = completed recovery + retired recovery.
 */
void endOfStreamRetiresTrailingRecoverySilenceExactly() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);

  output.complete(3U);
  output.nextEofLeadUs = 20'000U;
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 60U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(
      playback.metrics().underrunSilenceFramesSubmitted ==
      1U);

  /*
   * Frame five is ordered but already late: its physical slot is the recovery
   * descriptor just appended behind frames two through four. Paying the debt
   * leaves no new content after frame four, so EOS will stop while that
   * recovery descriptor is still pending.
   */
  fixture.publish(5, 65U);
  fixture.publishEnd(65U);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 65U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(
      playback.metrics().underrunLateFramesDropped == 1U);

  for (std::uint64_t nowMs = 80U;
       output.running && nowMs <= 140U;
       nowMs += 20U) {
    output.complete(1U);
    TEST_ASSERT(
        playback.pump(
            fixture.lane, output, nowMs).status ==
        ITERATE_KIT_OK);
  }

  const auto metrics = playback.metrics();
  TEST_ASSERT(!output.running);
  TEST_ASSERT(metrics.endOfStreamResponses == 1U);
  TEST_ASSERT(metrics.underrunSilenceFramesCompleted == 0U);
  TEST_ASSERT(
      metrics.underrunSilenceFramesRetired == 1U);
  TEST_ASSERT(
      metrics.underrunSilenceFramesSubmitted ==
      metrics.underrunSilenceFramesCompleted +
          metrics.underrunSilenceFramesRetired);
}

/*
 * Four accumulated EOFs are not four harmless write credits. In cyclic DMA,
 * reaching the fourth EOF means hardware has already wrapped toward the first
 * descriptor, so frames written only after the owner wakes cannot prevent old
 * descriptor zero from replaying. Keeping fresh lane frames ready before this
 * pump makes the regression especially important: a FIFO model is tempted to
 * refill all four slots and report a continuous run even though the acoustic
 * deadline has already been missed.
 */
void aCompleteDmaCycleCannotBeRefilledAfterItsDeadline() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(playback.pump(fixture.lane, output, 0U).playbackStarted);

  for (std::int16_t value = 5; value <= 8; ++value) {
    fixture.publish(value, 70U);
  }
  output.complete(4U);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 80U).status ==
      ITERATE_KIT_OK);

  TEST_ASSERT(playback.metrics().underrunIncidents == 1U);
  TEST_ASSERT(output.stopCount == 1U);
  TEST_ASSERT(
      output.submittedHistory ==
      std::vector<std::int16_t>({1, 2, 3, 4}));
  struct iterate_kit_spsc_ring_metrics ringMetrics {};
  iterate_kit_spsc_ring_metrics(
      &fixture.downlinkRing, &ringMetrics);
  TEST_ASSERT(ringMetrics.current_slots == 4U);
}

/*
 * A count of three EOFs is not enough to decide whether refill is safe. At
 * 500 us before the next cyclic wrap, the owner cannot rely on completing even
 * one bounded stereo copy before descriptor zero is selected again. This
 * models CPU/load starvation without pretending the task wakes exactly on each
 * frame boundary; the late generation must be reset, never reported seamless.
 */
void nearWrapWakeupIsADeadlineMissBeforeTheFourthEof() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(playback.pump(fixture.lane, output, 0U).playbackStarted);
  for (std::int16_t value = 5; value <= 7; ++value) {
    fixture.publish(value, 59U);
  }

  output.complete(3U);
  output.oldestEofToOwnerUs = 19'500U;
  output.nextEofLeadUs = 500U;
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 79U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(playback.metrics().dmaDeadlineMissIncidents == 1U);
  TEST_ASSERT(playback.metrics().underrunIncidents == 1U);
  TEST_ASSERT(
      output.submittedHistory ==
      std::vector<std::int16_t>({1, 2, 3, 4}));
}

/*
 * ESP-IDF's finished-pointer queue can retain three exact descriptors. At that
 * boundary the owner must consume one pointer before the next EOF, but filling
 * all three with silence would throw away another 40 ms of valid hardware
 * reserve. Consume only the oldest descriptor, retain the other two with their
 * independently decaying deadline, and later use them for the first content
 * frames which are still timely.
 *
 * The first ordered frame after recovery still belongs to the replaced slot
 * and is discarded. Frames after that must refill the retained descriptors
 * without a reset or another manufactured silence interval.
 */
void recoverySilenceConsumesOnlyOldestAtDriverCapacity() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(playback.pump(fixture.lane, output, 0U).playbackStarted);

  output.complete(3U);
  output.oldestEofToOwnerUs = 0U;
  output.nextEofLeadUs = 20'000U;
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 60U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(playback.metrics().dmaDeadlineMissIncidents == 0U);
  TEST_ASSERT(output.runningSilenceWrites == 1U);
  TEST_ASSERT(
      playback.metrics().underrunSilenceFramesSubmitted ==
      1U);
  TEST_ASSERT(playback.metrics().underrunIncidents == 1U);

  output.oldestEofToOwnerUs = 19'000U;
  output.nextEofLeadUs = 21'000U;
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 79U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(playback.metrics().dmaDeadlineMissIncidents == 0U);
  TEST_ASSERT(playback.metrics().underrunIncidents == 1U);
  TEST_ASSERT(output.running);

  for (std::int16_t value = 5; value <= 7; ++value) {
    fixture.publish(value, 79U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 79U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(
      playback.metrics().underrunLateFramesDropped == 1U);
  TEST_ASSERT(
      output.submittedHistory ==
      std::vector<std::int16_t>({1, 2, 3, 4, 6, 7}));
}

/*
 * The minimum lead is copy/setup margin, not a duration the owner may consume
 * completely. Equality leaves zero allowance for the policy instructions and
 * backend write that follow the check, so treating it as safe is an off-by-one
 * deadline bug at the exact configured boundary.
 */
void exactMinimumRefillLeadIsAlreadyUnsafe() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 5; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);
  output.complete(1U);
  output.oldestEofToOwnerUs = 58'000U;
  output.nextEofLeadUs = minimumRefillLeadUs;

  TEST_ASSERT(
      playback.pump(fixture.lane, output, 78U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(output.attemptedWrites.empty());
  TEST_ASSERT(!output.running);
  TEST_ASSERT(playback.metrics().dmaDeadlineMissIncidents == 1U);
  TEST_ASSERT(playback.metrics().underrunIncidents == 1U);
}

/*
 * A WebSocket reconnect can occur while old speech exists in three ownership
 * domains: already cycling in DMA, completed-but-not-reconciled driver state,
 * and the application lane. Accepting the new generation before all three are
 * flushed is the exact first-frame race seen on hardware. This test requires a
 * synchronous audio-owner fence and proves no value from generation one is
 * submitted after generation two starts.
 */
void generationBarrierFlushesHardwareDriverAndLaneOwnership() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 6; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(playback.pump(fixture.lane, output, 0U).playbackStarted);
  output.complete(1U);

  TEST_ASSERT(
      playback.flushGeneration(
          fixture.lane, output, 2U) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(playback.acceptedGeneration() == 2U);
  TEST_ASSERT(output.currentDma.empty());
  TEST_ASSERT(playback.metrics().dmaFramesCompleted == 1U);
  TEST_ASSERT(playback.metrics().generationFramesFlushed == 5U);

  for (std::int16_t value = 21; value <= 24; ++value) {
    fixture.publish(value, 20U);
  }
  TEST_ASSERT(playback.pump(fixture.lane, output, 20U).playbackStarted);
  TEST_ASSERT(
      output.currentDma ==
      std::vector<std::int16_t>({21, 22, 23, 24}));
  TEST_ASSERT(
      output.submittedHistory ==
      std::vector<std::int16_t>({1, 2, 3, 4, 21, 22, 23, 24}));
}

/*
 * The socket opens before any PCM is playing, so its first generation fence
 * necessarily runs while DMA is disabled. Requiring a completion poll in that
 * state couples policy to an illegal ESP-IDF operation and rejects the first
 * real response. A buffering fence has no in-flight EOFs to reconcile: it must
 * stop/reset the descriptors, discard the lane, and publish generation
 * acceptance without asking a stopped driver for completions.
 */
void initialGenerationBarrierDoesNotPollStoppedDma() {
  LaneFixture fixture;
  FakeDirectOutput output;
  output.rejectPollWhileStopped = true;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  fixture.publish(9, 0U);

  TEST_ASSERT(
      playback.flushGeneration(
          fixture.lane, output, 1U) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(playback.acceptedGeneration() == 1U);
  TEST_ASSERT(playback.metrics().generationFramesFlushed == 1U);
  TEST_ASSERT(
      playback.metrics().state ==
      iterate::kit::platforms::RealtimePlaybackState::
          buffering);
}

/*
 * Capacity is not permission to play history. If task starvation or a network
 * burst leaves the oldest frame beyond the explicit age bound, draining FIFO
 * would make the assistant respond in the past. The policy must discard that
 * bounded epoch, reset every descriptor, and expose one freshness incident.
 */
void staleDownlinkIsPurgedInsteadOfPlayedLate() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 6; ++value) {
    fixture.publish(value, 100U);
  }

  TEST_ASSERT(
      playback.pump(fixture.lane, output, 301U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(output.startCount == 0U);
  TEST_ASSERT(output.submittedHistory.empty());
  TEST_ASSERT(playback.metrics().freshnessIncidents == 1U);
  TEST_ASSERT(playback.metrics().freshnessFramesDropped == 6U);
}

/*
 * A production Grok run delivered every frame in order with at most 40 ms
 * between socket messages, yet Core-1 did not submit the first DMA epoch until
 * its oldest frame was 257 ms old. The former 200 ms target cutoff turned that
 * finite startup scheduling excursion into a 15-frame audible clip. The
 * production policy must admit this measured envelope without weakening the
 * generic test above: genuinely old speech still has a separate hard bound.
 */
void productionStartupJitterDoesNotClipAnOrderedResponse() {
  LaneFixture fixture;
  M5StickS3ProductionFakeDirectOutput output;
  M5StickS3ProductionPlayback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1;
       value <= static_cast<std::int16_t>(
                    m5StickS3ProductionDescriptorCount);
       ++value) {
    fixture.publish(value, 100U);
  }

  const auto result = playback.pump(fixture.lane, output, 357U);
  TEST_ASSERT(result.status == ITERATE_KIT_OK);
  TEST_ASSERT(result.playbackStarted);
  TEST_ASSERT(
      output.submittedHistory.size() ==
      m5StickS3ProductionDescriptorCount);
  for (std::size_t index = 0U;
       index < output.submittedHistory.size();
       ++index) {
    TEST_ASSERT(
        output.submittedHistory[index] ==
        static_cast<std::int16_t>(index + 1U));
  }
  TEST_ASSERT(playback.metrics().freshnessIncidents == 0U);
  TEST_ASSERT(playback.metrics().freshnessFramesDropped == 0U);
}

/*
 * The August 2 production Stick trace observed a 90 ms provider-to-device
 * interarrival gap. Four 20 ms descriptors could not span that interval: two
 * physical slots were replaced by silence and the matching ordered frames had
 * to be discarded, producing the same clipped reply the user heard. This is
 * ordinary bounded delivery jitter, not permission to accumulate a software
 * FIFO. ESP-IDF sizes dma_desc_num from the worst measured service interval,
 * so the production hardware cycle itself must absorb five elapsed 20 ms
 * slots and then refill them in place without silence, drops, or a reset.
 */
void productionReserveAbsorbsMeasuredNinetyMillisecondGap() {
  constexpr std::size_t descriptorCount =
      m5StickS3ProductionDescriptorCount;
  static_assert(descriptorCount >= 8U);
  LaneFixture fixture;
  FakeDirectOutputFor<descriptorCount> output;
  M5StickS3ProductionPlayback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1;
       value <= static_cast<std::int16_t>(descriptorCount);
       ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);

  /* Five EOFs are possible across a phase-aligned 90 ms delivery gap. */
  output.complete(5U);
  output.oldestEofToOwnerUs = 80'000U;
  output.nextEofLeadUs = 60'000U;
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 90U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(playback.metrics().underrunIncidents == 0U);
  TEST_ASSERT(output.runningSilenceWrites == 0U);

  for (std::int16_t value =
           static_cast<std::int16_t>(descriptorCount + 1U);
       value <= static_cast<std::int16_t>(descriptorCount + 5U);
       ++value) {
    fixture.publish(value, 90U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 90U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(playback.metrics().underrunLateFramesDropped == 0U);
  TEST_ASSERT(playback.metrics().underrunSilenceFramesSubmitted == 0U);
  TEST_ASSERT(output.stopCount == 0U);
  TEST_ASSERT(
      output.submittedHistory.size() == descriptorCount + 5U);
  for (std::size_t index = 0U;
       index < output.submittedHistory.size();
       ++index) {
    TEST_ASSERT(
        output.submittedHistory[index] ==
        static_cast<std::int16_t>(index + 1U));
  }
}

/*
 * The August 2 eight-descriptor production proof then observed a 250 ms
 * provider-to-device interarrival gap: all 148 frames reached the Stick, but
 * thirteen phase-aligned 20 ms EOFs exhausted the 160 ms hardware cycle and
 * forced exactly one recovery-silence/late-frame pair. The interval was
 * network-invalid (111 ms host RTT), yet realtime recovery must become clean
 * again as soon as current packets resume; clipping a complete ordered reply
 * is not an acceptable recovery policy. Sixteen physical descriptors span the
 * measured thirteen EOFs with two completed-pointer slots of margin. This is
 * still a bounded DMA ownership cycle—not a software FIFO—and the independent
 * 400 ms freshness fence continues to purge speech after a real outage.
 */
void productionReserveAbsorbsMeasuredTwoHundredFiftyMillisecondGap() {
  constexpr std::size_t descriptorCount =
      m5StickS3ProductionDescriptorCount;
  static_assert(descriptorCount >= 16U);
  LaneFixture fixture;
  FakeDirectOutputFor<descriptorCount> output;
  M5StickS3ProductionPlayback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1;
       value <= static_cast<std::int16_t>(descriptorCount);
       ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);

  /* Thirteen EOFs are possible across a phase-aligned 250 ms gap. */
  output.complete(13U);
  output.oldestEofToOwnerUs = 240'000U;
  output.nextEofLeadUs = 60'000U;
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 250U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(playback.metrics().underrunIncidents == 0U);
  TEST_ASSERT(output.runningSilenceWrites == 0U);

  for (std::int16_t value =
           static_cast<std::int16_t>(descriptorCount + 1U);
       value <= static_cast<std::int16_t>(descriptorCount + 13U);
       ++value) {
    fixture.publish(value, 250U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 250U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(playback.metrics().underrunLateFramesDropped == 0U);
  TEST_ASSERT(playback.metrics().underrunSilenceFramesSubmitted == 0U);
  TEST_ASSERT(playback.metrics().dmaDeadlineMissIncidents == 0U);
  TEST_ASSERT(output.stopCount == 0U);
  TEST_ASSERT(
      output.submittedHistory.size() == descriptorCount + 13U);
  for (std::size_t index = 0U;
       index < output.submittedHistory.size();
       ++index) {
    TEST_ASSERT(
        output.submittedHistory[index] ==
        static_cast<std::int16_t>(index + 1U));
  }
}

/*
 * Raising a measured startup envelope must not turn the 640 ms loss reserve
 * into permission to replay it. At one millisecond beyond the target policy,
 * all queued speech belongs to a failed realtime epoch and must be discarded
 * with exact diagnostics before any descriptor or amplifier starts.
 */
void productionSpeechPastTheBoundIsStillPurged() {
  LaneFixture fixture;
  FakeDirectOutput output;
  M5StickS3ProductionPlayback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 6; ++value) {
    fixture.publish(value, 100U);
  }

  TEST_ASSERT(
      playback.pump(fixture.lane, output, 501U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(output.startCount == 0U);
  TEST_ASSERT(output.submittedHistory.empty());
  TEST_ASSERT(playback.metrics().freshnessIncidents == 1U);
  TEST_ASSERT(playback.metrics().freshnessFramesDropped == 6U);
}

/*
 * Without PCM end-of-stream metadata, a one-to-three-frame response can sit
 * preloaded forever and silently consume current speech. The MVP explicitly
 * classifies and discards that incomplete reserve after a short bound. Future
 * EOS support may choose to play it, but accidental indefinite retention is
 * never an acceptable third behavior.
 */
void partialPrebufferTimesOutAsOneClassifiedDiscard() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  fixture.publish(7, 10U);
  fixture.publish(8, 20U);
  TEST_ASSERT(
      !playback.pump(fixture.lane, output, 20U).playbackStarted);

  TEST_ASSERT(
      playback.pump(
          fixture.lane,
          output,
          20U + partialPrebufferTimeoutMs).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(playback.metrics().partialPrebufferIncidents == 1U);
  TEST_ASSERT(playback.metrics().partialPrebufferFramesDropped == 2U);
  TEST_ASSERT(output.startCount == 0U);
  TEST_ASSERT(output.currentDma.empty());
}

/*
 * Real provider responses are not obliged to contain a multiple of four
 * frames. With cyclic DMA, waiting for a full prebuffer drops N=1..3, while
 * treating the last EOF as starvation labels every finite N>=4 response an
 * underrun. The ordered EOS permits silent descriptor padding only behind
 * content, then a clean stop on the final content EOF. Every input frame must
 * be submitted and complete exactly once for each boundary case around the
 * four-descriptor reserve.
 */
void finiteResponsesFromOneThroughFiveFramesEndCleanly() {
  for (std::size_t frameCount = 1U;
       frameCount <= 5U;
       ++frameCount) {
    LaneFixture fixture;
    FakeDirectOutput output;
    Playback playback;
    TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
    for (std::size_t index = 0U;
         index < frameCount;
         ++index) {
      fixture.publish(
          static_cast<std::int16_t>(index + 1U), 0U);
    }
    fixture.publishEnd(0U);

    TEST_ASSERT(
        playback.pump(fixture.lane, output, 0U).status ==
        ITERATE_KIT_OK);
    for (std::uint64_t nowMs = 20U;
         output.running && nowMs <= 200U;
         nowMs += 20U) {
      output.complete(1U);
      TEST_ASSERT(
          playback.pump(
              fixture.lane, output, nowMs).status ==
          ITERATE_KIT_OK);
    }

    TEST_ASSERT(!output.running);
    TEST_ASSERT(
        playback.metrics().state ==
        iterate::kit::platforms::RealtimePlaybackState::
            buffering);
    TEST_ASSERT(
        playback.metrics().dmaFramesSubmitted ==
        frameCount);
    TEST_ASSERT(
        playback.metrics().dmaFramesCompleted ==
        frameCount);
    TEST_ASSERT(
        playback.metrics().endOfStreamResponses == 1U);
    TEST_ASSERT(playback.metrics().underrunIncidents == 0U);
    TEST_ASSERT(
        output.submittedHistory.size() == frameCount);
    for (std::size_t index = 0U;
         index < frameCount;
         ++index) {
      TEST_ASSERT(
          output.submittedHistory[index] ==
          static_cast<std::int16_t>(index + 1U));
    }
  }
}

/*
 * IDF's completion queue legally wakes the owner with three EOFs at once. For
 * a one-frame response the first descriptor is content and the next two are
 * EOS padding silence. Counting the whole batch as content makes
 * `completed(3) > currentContent(1)`, falsely fails a healthy response, and
 * leaves the amplifier/DMA running because no later pump performs cleanup.
 *
 * This is the shortest response and largest legal callback batch, so it pins
 * both requirements: padding ownership is reconciled without becoming speech,
 * and the final content EOF stops the hardware synchronously.
 */
void delayedOwnerBatchDistinguishesContentFromEosPadding() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  fixture.publish(1, 0U);
  fixture.publishEnd(0U);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);

  output.complete(3U);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 60U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(!output.running);
  TEST_ASSERT(output.stopCount == 1U);
  TEST_ASSERT(playback.metrics().dmaFramesCompleted == 1U);
  TEST_ASSERT(
      playback.metrics().state ==
      iterate::kit::platforms::RealtimePlaybackState::
          buffering);
  TEST_ASSERT(
      playback.metrics().endOfStreamResponses == 1U);
  TEST_ASSERT(playback.metrics().stateErrors == 0U);
}

/*
 * A pending-count mismatch means exact descriptor ownership has already been
 * lost. Merely setting the policy state to failed is unsafe: cyclic I2S keeps
 * selecting descriptors, the amplifier remains enabled, and future pump()
 * calls return early forever. Every fatal policy path must synchronously
 * prevent further DMA before it reports failure.
 */
void fatalDescriptorAccountingMismatchStopsHardware() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);
  output.complete(1U);
  output.reportedPendingOverride = 2U;
  output.useReportedPendingOverride = true;

  TEST_ASSERT(
      playback.pump(fixture.lane, output, 20U).status ==
      ITERATE_KIT_STATE_ERROR);
  TEST_ASSERT(!output.running);
  TEST_ASSERT(output.stopCount == 1U);
  TEST_ASSERT(
      playback.metrics().state ==
      iterate::kit::platforms::RealtimePlaybackState::
          failed);
}

/*
 * Token counts and generation alone cannot prove descriptor identity. A
 * duplicated/reordered callback may still carry a valid token and current
 * generation, but accepting sequence one where sequence zero is due would
 * conceal an audible skip while every aggregate count remained balanced.
 */
void completionMetadataSequenceMustBeExact() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);
  output.complete(1U);
  TEST_ASSERT(output.unpolledCompletions.size() == 1U);
  output.unpolledCompletions[0].frame.sequence = 1U;

  TEST_ASSERT(
      playback.pump(fixture.lane, output, 20U).status ==
      ITERATE_KIT_STATE_ERROR);
  TEST_ASSERT(!output.running);
  TEST_ASSERT(output.stopCount == 1U);
  TEST_ASSERT(playback.metrics().stateErrors == 1U);
}

/*
 * EOF timestamps are the hardware ordering authority for latency and deadline
 * metrics. A duplicate/regressing timestamp must poison the generation rather
 * than produce a plausible zero delay: otherwise a callback replay can pass
 * sequence/count checks while corrupting the physical timeline.
 */
void completionEofTimestampMustIncreaseStrictly() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 6; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);
  output.complete(1U);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 20U).status ==
      ITERATE_KIT_OK);

  output.complete(1U);
  TEST_ASSERT(output.unpolledCompletions.size() == 1U);
  output.unpolledCompletions[0].eofAtUs = 20'000U;
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 40U).status ==
      ITERATE_KIT_STATE_ERROR);
  TEST_ASSERT(!output.running);
  TEST_ASSERT(output.stopCount == 1U);
  TEST_ASSERT(playback.metrics().stateErrors == 1U);
}

/*
 * A hard/partial direct-I2S write can leave descriptor contents unknowable.
 * There is no safe retry cursor for a torn PCM frame. The failure is useful
 * only after stopAndRelease has made the hardware quiet; otherwise diagnostics
 * report a stopped software state while stale sound still cycles physically.
 */
void fatalWriteFailureStopsHardwareBeforeReturning() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 5; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);
  output.complete(1U);
  output.nextWriteStatus = ITERATE_KIT_IO_ERROR;

  TEST_ASSERT(
      playback.pump(fixture.lane, output, 20U).status ==
      ITERATE_KIT_IO_ERROR);
  TEST_ASSERT(!output.running);
  TEST_ASSERT(output.stopCount == 1U);
  TEST_ASSERT(
      playback.metrics().state ==
      iterate::kit::platforms::RealtimePlaybackState::
          failed);
}

/*
 * ESP-IDF 5.4.2 publishes the completed-buffer pointer to its private TX
 * queue before the ISR can yield to this higher-priority owner. Consequently,
 * a timeout-zero write with no progress after a valid EOF is not ordinary
 * scheduler jitter: it means our sole-writer/descriptor invariant is broken.
 *
 * Retrying on a later tick used to inject an otherwise self-inflicted 10 ms
 * hole at this target's 100 Hz tick rate. The bounded response is instead to
 * release and count the one borrowed lane head, stop the suspect generation,
 * and re-enter clean four-frame buffering in the same owner pump.
 */
void zeroProgressWriteResetsTheSuspectGenerationImmediately() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 5; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);
  output.complete(1U);
  output.nextWriteStatus = ITERATE_KIT_BACKPRESSURE;

  const auto result =
      playback.pump(fixture.lane, output, 20U);
  TEST_ASSERT(result.status == ITERATE_KIT_OK);
  TEST_ASSERT(!fixture.downlinkRing.read_acquired);
  TEST_ASSERT(!output.running);
  TEST_ASSERT(output.stopCount == 1U);
  TEST_ASSERT(
      output.submittedHistory ==
      std::vector<std::int16_t>({1, 2, 3, 4}));
  TEST_ASSERT(
      playback.metrics().writeBackpressureIncidents ==
      1U);
  TEST_ASSERT(
      playback.metrics().
          writeBackpressureDestructiveResets == 1U);
  TEST_ASSERT(
      playback.metrics().writeBackpressureFramesDropped ==
      1U);
  TEST_ASSERT(playback.metrics().underrunIncidents == 1U);
}

/*
 * Callback-to-owner delay stops before the stereo expansion and physical
 * i2s_channel_write() copy. Using it as the service SLO allowed a slow copy to
 * look healthy even though the descriptor was not ready for hardware reuse.
 * The driver therefore reports the timestamp taken after the exact full write,
 * its call duration, and the real lead left at that boundary.
 */
void successfulRefillTimingIncludesTheCompletedDriverCopy() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 5; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);
  output.complete(1U);
  output.oldestEofToOwnerUs = 600U;
  output.nextEofLeadUs = 59'400U;
  output.nextRefillTiming = {
    true, 850U, 120U, 59'150U};

  TEST_ASSERT(
      playback.pump(fixture.lane, output, 20U).status ==
      ITERATE_KIT_OK);
  const auto metrics = playback.metrics();
  TEST_ASSERT(metrics.maximumEofToOwnerUs == 600U);
  TEST_ASSERT(metrics.successfulRefillTimingSamples == 1U);
  TEST_ASSERT(
      metrics.lastEofToSuccessfulRefillUs == 850U);
  TEST_ASSERT(
      metrics.maximumEofToSuccessfulRefillUs == 850U);
  TEST_ASSERT(metrics.lastWriteCallDurationUs == 120U);
  TEST_ASSERT(metrics.maximumWriteCallDurationUs == 120U);
  TEST_ASSERT(
      metrics.lastReuseLeadAtSuccessfulRefillUs ==
      59'150U);
  TEST_ASSERT(
      metrics.minimumReuseLeadAtSuccessfulRefillUs ==
      59'150U);
}

/*
 * The ISR can overflow ESP-IDF's private finished-buffer queue after the
 * owner's first overflow check but while completion polling is in progress.
 * At that point a count/token snapshot may look coherent even though the next
 * public write would refill a different descriptor. A post-poll poison check
 * must stop/reset before issuing any write; continuing would turn a transient
 * scheduler delay into deterministic descriptor-identity corruption.
 */
void overflowRaisedDuringCompletionPollPreventsEveryWrite() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 5; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);
  output.complete(1U);
  output.overflowDuringNextPoll = true;

  TEST_ASSERT(
      playback.pump(fixture.lane, output, 20U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(output.attemptedWrites.empty());
  TEST_ASSERT(!output.running);
  TEST_ASSERT(output.stopCount == 1U);
  TEST_ASSERT(
      playback.metrics().driverQueueOverflowIncidents == 1U);
  TEST_ASSERT(playback.metrics().underrunIncidents == 1U);
}

/*
 * Hardware ownership is destroyed before lane discard begins. If the lane is
 * corrupt, classifying the four stopped DMA frames only after discard returns
 * would make those frames disappear from generation diagnostics and reappear
 * as an unrelated fatal loss. Commit each ownership transition as it succeeds,
 * even when a later cleanup layer discovers a separate invariant violation.
 */
void generationFlushAccountsStoppedDmaBeforeDiscardFailure() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 5; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);
  fixture.downlinkStorage[4U].kind =
      static_cast<iterate_kit_pcm_downlink_slot_kind>(99);

  TEST_ASSERT(
      playback.flushGeneration(
          fixture.lane, output, 2U) ==
      ITERATE_KIT_STATE_ERROR);
  TEST_ASSERT(!output.running);
  TEST_ASSERT(
      playback.metrics().generationFramesFlushed == 4U);
  TEST_ASSERT(playback.metrics().fatalFramesFlushed == 0U);
}

/*
 * Driver copy and ring release are two distinct ownership transitions. If a
 * preload succeeds and release then fails, the frame is already in DMA but the
 * SPSC slot is still reserved. The failure path must retain a cleanup token,
 * count the frame once through hardware loss, and release the alias later
 * without double-counting that one logical PCM frame.
 */
void preloadReleaseFailureUnwedgesWithoutDoubleCounting() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  fixture.publish(7, 0U);
  output.invalidateRingDuringNextPreload =
      &fixture.downlinkRing;

  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).status ==
      ITERATE_KIT_INVALID_ARGUMENT);
  TEST_ASSERT(fixture.downlinkRing.read_acquired);
  TEST_ASSERT(!output.running);
  TEST_ASSERT(playback.metrics().dmaFramesSubmitted == 1U);
  TEST_ASSERT(playback.metrics().fatalFramesFlushed == 1U);

  fixture.downlinkRing.initialized = true;
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 1U).status ==
      ITERATE_KIT_STATE_ERROR);
  TEST_ASSERT(!fixture.downlinkRing.read_acquired);
  TEST_ASSERT(playback.metrics().fatalFramesFlushed == 1U);
}

/*
 * A rejected preload leaves the acquired content outside both DMA and the
 * ordinary lane cursor. Releasing that slot is a real destructive loss, not
 * merely a driver incident; it must be committed before fatal cleanup even
 * though no descriptor content exists for clearFailedOwnership() to count.
 */
void preloadFailureClassifiesReleasedInputFrame() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  fixture.publish(7, 0U);
  output.nextPreloadStatus = ITERATE_KIT_IO_ERROR;

  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).status ==
      ITERATE_KIT_IO_ERROR);
  TEST_ASSERT(!fixture.downlinkRing.read_acquired);
  TEST_ASSERT(!output.running);
  TEST_ASSERT(playback.metrics().dmaFramesSubmitted == 0U);
  TEST_ASSERT(playback.metrics().fatalFramesFlushed == 1U);
  TEST_ASSERT(playback.metrics().driverFailures == 1U);
}

/*
 * The same split transition occurs on a running descriptor refill. Recording
 * submission only after ring release hides a frame the driver already copied;
 * forgetting the acquired slot wedges the producer. The stopped-hardware
 * total includes all four in-flight content frames exactly once, even though
 * the fifth lane slot required a later cleanup attempt.
 */
void runningWriteReleaseFailureUnwedgesWithoutDoubleCounting() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 5; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);
  output.complete(1U);
  output.invalidateRingDuringNextWrite =
      &fixture.downlinkRing;

  TEST_ASSERT(
      playback.pump(fixture.lane, output, 20U).status ==
      ITERATE_KIT_INVALID_ARGUMENT);
  TEST_ASSERT(fixture.downlinkRing.read_acquired);
  TEST_ASSERT(!output.running);
  TEST_ASSERT(playback.metrics().dmaFramesSubmitted == 5U);
  TEST_ASSERT(playback.metrics().fatalFramesFlushed == 4U);

  fixture.downlinkRing.initialized = true;
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 21U).status ==
      ITERATE_KIT_STATE_ERROR);
  TEST_ASSERT(!fixture.downlinkRing.read_acquired);
  TEST_ASSERT(playback.metrics().fatalFramesFlushed == 4U);
}

/*
 * The triggering stale frame has already left the lane before hardware stop
 * is attempted. A driver-stop failure must not erase that known loss merely
 * because the rest of the epoch remains in an uncertain hardware state.
 * Freshness counters are an ownership ledger, so update them at release time.
 */
void freshnessDropSurvivesDriverStopFailure() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 5; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);
  output.complete(1U);
  output.nextStopStatus = ITERATE_KIT_IO_ERROR;

  TEST_ASSERT(
      playback.pump(fixture.lane, output, 201U).status ==
      ITERATE_KIT_IO_ERROR);
  TEST_ASSERT(!fixture.downlinkRing.read_acquired);
  TEST_ASSERT(playback.metrics().freshnessIncidents == 1U);
  TEST_ASSERT(playback.metrics().freshnessFramesDropped == 1U);
}

/*
 * EOS is not merely a short-response escape hatch. During an endurance run it
 * arrives after thousands of ordinary descriptor refills and must drain the
 * last four-frame reserve without changing order, dropping the tail, or
 * converting the expected boundary into an underrun. One hundred frames keeps
 * this host test fast while crossing the ring and DMA indices many times.
 */
void steadyStreamingResponseDrainsItsExactTailAtEndOfStream() {
  constexpr std::int16_t frameCount = 250;
  LaneFixture fixture;
  FakeDirectOutput output;
  /*
   * This is the exact July 30 physical trace rather than an abstract EOS
   * scenario. A five-second response is 250 frames, while ESP-IDF gives four
   * DMA descriptors only three completed-pointer queue entries. Draining must
   * actively consume those pointers with silence behind the remaining content;
   * merely waiting for the final content EOF loses descriptor identity on the
   * fourth callback and truncates otherwise healthy speech.
   */
  output.enforceBoundedDriverQueue = true;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);

  std::uint64_t nowMs = 20U;
  for (std::int16_t value = 5;
       value <= frameCount;
       ++value, nowMs += 20U) {
    output.complete(1U);
    fixture.publish(value, nowMs);
    TEST_ASSERT(
        playback.pump(
            fixture.lane, output, nowMs).status ==
        ITERATE_KIT_OK);
  }
  output.complete(1U);
  fixture.publishEnd(nowMs);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, nowMs).status ==
      ITERATE_KIT_OK);
  while (output.running) {
    nowMs += 20U;
    output.complete(1U);
    TEST_ASSERT(
        playback.pump(
            fixture.lane, output, nowMs).status ==
        ITERATE_KIT_OK);
  }

  TEST_ASSERT(
      playback.metrics().dmaFramesSubmitted ==
      static_cast<std::uint32_t>(frameCount));
  TEST_ASSERT(
      playback.metrics().dmaFramesCompleted ==
      static_cast<std::uint32_t>(frameCount));
  TEST_ASSERT(playback.metrics().underrunIncidents == 0U);
  TEST_ASSERT(
      playback.metrics().driverQueueOverflowIncidents ==
      0U);
  TEST_ASSERT(
      playback.metrics().endOfStreamResponses == 1U);
  TEST_ASSERT(output.runningSilenceWrites == 3U);
  TEST_ASSERT(
      output.submittedHistory.size() ==
      static_cast<std::size_t>(frameCount));
  for (std::int16_t value = 1;
       value <= frameCount;
       ++value) {
    TEST_ASSERT(
        output.submittedHistory[
            static_cast<std::size_t>(value - 1)] ==
        value);
  }
}

/*
 * Ten minutes at the wire's fixed 20 ms cadence crosses 30,000 descriptor
 * handoffs—far beyond ring wrap, DMA wrap, and 16-bit-looking counter values.
 * This is the deterministic inner loop behind the physical 1/2/10-minute
 * ladder: every frame and metadata sequence must survive exactly once, the
 * ordered EOS must drain the final reserve, and every loss/fault counter must
 * remain zero. It is deliberately fast in host time so every edit exercises
 * the same state-machine distance as a real endurance recording.
 */
void tenMinuteDescriptorSoakPreservesEveryFrameExactlyOnce() {
  constexpr std::int32_t frameCount =
      10 * 60 * 1000 /
      static_cast<std::int32_t>(
          frameDurationMs);
  static_assert(frameCount == 30'000);

  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);

  std::uint64_t nowMs =
      frameDurationMs;
  for (std::int32_t sequence = 5;
       sequence <= frameCount;
       ++sequence) {
    output.complete(1U);
    fixture.publish(
        static_cast<std::int16_t>(sequence), nowMs);
    const auto result =
        playback.pump(fixture.lane, output, nowMs);
    TEST_ASSERT(result.status == ITERATE_KIT_OK);
    nowMs += frameDurationMs;
  }

  output.complete(1U);
  fixture.publishEnd(nowMs);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, nowMs).status ==
      ITERATE_KIT_OK);
  while (output.running) {
    nowMs += frameDurationMs;
    output.complete(1U);
    TEST_ASSERT(
        playback.pump(
            fixture.lane, output, nowMs).status ==
        ITERATE_KIT_OK);
  }

  const auto metrics = playback.metrics();
  TEST_ASSERT(
      metrics.dmaFramesSubmitted ==
      static_cast<std::uint32_t>(frameCount));
  TEST_ASSERT(
      metrics.dmaFramesCompleted ==
      static_cast<std::uint32_t>(frameCount));
  TEST_ASSERT(metrics.underrunIncidents == 0U);
  TEST_ASSERT(metrics.dmaDeadlineMissIncidents == 0U);
  TEST_ASSERT(metrics.driverQueueOverflowIncidents == 0U);
  TEST_ASSERT(metrics.driverFailures == 0U);
  TEST_ASSERT(metrics.stateErrors == 0U);
  TEST_ASSERT(metrics.freshnessIncidents == 0U);
  TEST_ASSERT(metrics.writeBackpressureIncidents == 0U);
  TEST_ASSERT(metrics.endOfStreamResponses == 1U);
  TEST_ASSERT(
      output.submittedHistory.size() ==
      static_cast<std::size_t>(frameCount));
  TEST_ASSERT(
      output.submittedMetadataHistory.size() ==
      static_cast<std::size_t>(frameCount));
  for (std::int32_t sequence = 0;
       sequence < frameCount;
       ++sequence) {
    TEST_ASSERT(
        output.submittedHistory[
            static_cast<std::size_t>(sequence)] ==
        static_cast<std::int16_t>(sequence + 1));
    TEST_ASSERT(
        output.submittedMetadataHistory[
            static_cast<std::size_t>(sequence)].sequence ==
        static_cast<std::uint32_t>(sequence));
  }
}

/*
 * Lower-priority work matters only through the service delay it imposes on the
 * audio owner. This ten-minute companion deliberately lets one, two, or three
 * DMA EOFs accumulate before each pump—the largest legal batch before a full
 * cyclic underrun—while producer frames continue arriving every 20 ms. The
 * oldest callback can therefore wait 40 ms, leaving 20 ms before descriptor
 * reuse. Exact order and zero-loss assertions prove the reserve absorbs that
 * bounded load without converting the lane into delayed history.
 *
 * This is not a substitute for measured physical CPU/NVS/display load; it is
 * the deterministic policy oracle that tells the device ladder what should
 * happen when that lower-priority load produces the same scheduling pattern.
 */
void tenMinuteLoadedOwnerSoakAbsorbsThreeEofBatches() {
  constexpr std::int32_t frameCount = 30'000;
  constexpr std::array<std::size_t, 6U> batchPattern{
    1U, 2U, 3U, 2U, 1U, 3U};
  constexpr std::uint32_t descriptorReuseIntervalUs =
      3U * 20'000U;

  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    fixture.publish(value, 0U);
  }
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).
          playbackStarted);

  std::int32_t nextFrame = 5;
  std::size_t batchIndex = 0U;
  std::uint64_t nowMs = 0U;
  while (nextFrame <= frameCount) {
    const auto requestedBatch =
        batchPattern[batchIndex % batchPattern.size()];
    const auto remaining =
        static_cast<std::size_t>(
            frameCount - nextFrame + 1);
    const auto batch =
        requestedBatch < remaining
        ? requestedBatch
        : remaining;
    output.complete(batch);
    for (std::size_t index = 0U;
         index < batch;
         ++index) {
      nowMs += frameDurationMs;
      fixture.publish(
          static_cast<std::int16_t>(nextFrame),
          nowMs);
      ++nextFrame;
    }
    output.oldestEofToOwnerUs =
        static_cast<std::uint32_t>(
            (batch - 1U) * 20'000U);
    output.nextEofLeadUs =
        descriptorReuseIntervalUs -
        output.oldestEofToOwnerUs;
    const auto result =
        playback.pump(fixture.lane, output, nowMs);
    TEST_ASSERT(result.status == ITERATE_KIT_OK);
    ++batchIndex;
  }

  output.complete(1U);
  nowMs += frameDurationMs;
  fixture.publishEnd(nowMs);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, nowMs).status ==
      ITERATE_KIT_OK);
  while (output.running) {
    nowMs += frameDurationMs;
    output.complete(1U);
    TEST_ASSERT(
        playback.pump(
            fixture.lane, output, nowMs).status ==
        ITERATE_KIT_OK);
  }

  const auto metrics = playback.metrics();
  TEST_ASSERT(metrics.dmaFramesSubmitted == 30'000U);
  TEST_ASSERT(metrics.dmaFramesCompleted == 30'000U);
  TEST_ASSERT(metrics.maximumEofToOwnerUs == 40'000U);
  TEST_ASSERT(metrics.minimumEarliestReuseLeadUs == 20'000U);
  TEST_ASSERT(metrics.underrunIncidents == 0U);
  TEST_ASSERT(metrics.dmaDeadlineMissIncidents == 0U);
  TEST_ASSERT(metrics.driverQueueOverflowIncidents == 0U);
  TEST_ASSERT(metrics.driverFailures == 0U);
  TEST_ASSERT(metrics.stateErrors == 0U);
  TEST_ASSERT(metrics.freshnessIncidents == 0U);
  TEST_ASSERT(
      output.submittedHistory.size() ==
      static_cast<std::size_t>(frameCount));
  for (std::int32_t sequence = 0;
       sequence < frameCount;
       ++sequence) {
    TEST_ASSERT(
        output.submittedHistory[
            static_cast<std::size_t>(sequence)] ==
        static_cast<std::int16_t>(sequence + 1));
  }
}

/*
 * Monotonic millisecond zero is a valid timestamp after boot, not an "unset"
 * sentinel. If the second frame can restart this deadline, sparse traffic can
 * retain a partial DMA generation indefinitely and later leak stale speech
 * into a new response.
 */
void partialPrebufferDeadlineStartsAtMonotonicZero() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  fixture.publish(7, 0U);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 0U).status ==
      ITERATE_KIT_OK);

  fixture.publish(8, 199U);
  TEST_ASSERT(
      playback.pump(fixture.lane, output, 199U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(playback.metrics().partialPrebufferIncidents == 0U);

  TEST_ASSERT(
      playback.pump(fixture.lane, output, 200U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(playback.metrics().partialPrebufferIncidents == 1U);
  TEST_ASSERT(playback.metrics().partialPrebufferFramesDropped == 2U);
}

/*
 * A receive timestamp ahead of the audio owner's monotonic clock means one of
 * the clocks or ownership boundaries is broken. Treating its age as zero
 * silently grants the frame maximum freshness and can play arbitrarily stale
 * audio after a clock-domain mistake. The safe bounded response is to discard
 * the epoch and surface both the clock and freshness incidents.
 */
void futureReceiveTimestampCannotBypassFreshness() {
  LaneFixture fixture;
  FakeDirectOutput output;
  Playback playback;
  TEST_ASSERT(playback.begin(output) == ITERATE_KIT_OK);
  fixture.publish(9, 101U);

  TEST_ASSERT(
      playback.pump(fixture.lane, output, 100U).status ==
      ITERATE_KIT_OK);
  TEST_ASSERT(output.submittedHistory.empty());
  TEST_ASSERT(playback.metrics().ownerClockRegressions == 1U);
  TEST_ASSERT(playback.metrics().freshnessIncidents == 1U);
  TEST_ASSERT(playback.metrics().freshnessFramesDropped == 1U);
}

}  // namespace

int main() {
  fourFreshFramesAreRequiredBeforePlaybackStarts();
  boundedJitterPlaysOneOrderedContinuousSequence();
  timelyFrameAfterEofUsesHardwareReserveWithoutSilence();
  underrunStopsOnceAndRebuffersFourFreshFrames();
  oneLateFrameUsesBoundedSilenceAndResumesWithoutReset();
  prolongedRecoveryDebtResetsAndRebuffersFreshAudio();
  endOfStreamClosesUnpayableRecoveryDebt();
  endOfStreamRetiresTrailingRecoverySilenceExactly();
  aCompleteDmaCycleCannotBeRefilledAfterItsDeadline();
  nearWrapWakeupIsADeadlineMissBeforeTheFourthEof();
  recoverySilenceConsumesOnlyOldestAtDriverCapacity();
  exactMinimumRefillLeadIsAlreadyUnsafe();
  generationBarrierFlushesHardwareDriverAndLaneOwnership();
  initialGenerationBarrierDoesNotPollStoppedDma();
  staleDownlinkIsPurgedInsteadOfPlayedLate();
  productionStartupJitterDoesNotClipAnOrderedResponse();
  productionReserveAbsorbsMeasuredNinetyMillisecondGap();
  productionReserveAbsorbsMeasuredTwoHundredFiftyMillisecondGap();
  productionSpeechPastTheBoundIsStillPurged();
  partialPrebufferTimesOutAsOneClassifiedDiscard();
  finiteResponsesFromOneThroughFiveFramesEndCleanly();
  delayedOwnerBatchDistinguishesContentFromEosPadding();
  fatalDescriptorAccountingMismatchStopsHardware();
  completionMetadataSequenceMustBeExact();
  completionEofTimestampMustIncreaseStrictly();
  fatalWriteFailureStopsHardwareBeforeReturning();
  zeroProgressWriteResetsTheSuspectGenerationImmediately();
  successfulRefillTimingIncludesTheCompletedDriverCopy();
  overflowRaisedDuringCompletionPollPreventsEveryWrite();
  generationFlushAccountsStoppedDmaBeforeDiscardFailure();
  preloadReleaseFailureUnwedgesWithoutDoubleCounting();
  preloadFailureClassifiesReleasedInputFrame();
  runningWriteReleaseFailureUnwedgesWithoutDoubleCounting();
  freshnessDropSurvivesDriverStopFailure();
  steadyStreamingResponseDrainsItsExactTailAtEndOfStream();
  tenMinuteDescriptorSoakPreservesEveryFrameExactlyOnce();
  tenMinuteLoadedOwnerSoakAbsorbsThreeEofBatches();
  partialPrebufferDeadlineStartsAtMonotonicZero();
  futureReceiveTimestampCannotBypassFreshness();
  return 0;
}
