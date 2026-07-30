#include "iterate/kit/platforms/bounded_playback.hpp"

#include "iterate/kit/pcm_lane.h"

#include <cstddef>
#include <cstdint>
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

constexpr std::size_t sampleCount = 320U;
constexpr std::size_t frameBytes =
    sampleCount * sizeof(std::int16_t);
constexpr std::size_t laneSlotCount = 4U;

struct LaneFixture {
  iterate_kit_spsc_ring uplinkRing{};
  iterate_kit_spsc_ring downlinkRing{};
  iterate_kit_pcm_uplink_slot
      uplinkStorage[laneSlotCount]{};
  iterate_kit_pcm_downlink_slot
      downlinkStorage[laneSlotCount]{};
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

  void publish(std::int16_t value) {
    std::int16_t frame[sampleCount];
    for (auto &sample : frame) sample = value;
    TEST_ASSERT(
        iterate_kit_pcm_lane_receive_downlink(
            &lane,
            ITERATE_KIT_PCM_MESSAGE_BINARY,
            true,
            sizeof(frame),
            0U,
            frame,
            sizeof(frame)) == ITERATE_KIT_OK);
  }
};

struct FakeSpeaker {
  struct Config {
    std::uint32_t sample_rate = 22'050U;
  };

  const std::int16_t *queued[2]{};
  std::size_t queuedCount = 0U;
  bool beginResult = true;
  bool prepared = false;
  bool rejectNext = false;
  Config speakerConfig{};

  Config config() const {
    return speakerConfig;
  }

  void config(const Config &nextConfig) {
    speakerConfig = nextConfig;
  }

  bool begin() {
    TEST_ASSERT(speakerConfig.sample_rate == 16'000U);
    prepared = beginResult;
    return beginResult;
  }

  std::size_t isPlaying(std::uint8_t channel) const {
    TEST_ASSERT(channel == 0U);
    return queuedCount;
  }

  bool playRaw(
      const std::int16_t *samples,
      std::size_t samplesToPlay,
      std::uint32_t sampleRate,
      bool stereo,
      std::uint32_t repeat,
      int channel,
      bool stopCurrentSound) {
    TEST_ASSERT(prepared);
    TEST_ASSERT(samples != nullptr);
    TEST_ASSERT(samplesToPlay == sampleCount);
    TEST_ASSERT(sampleRate == 16'000U);
    TEST_ASSERT(!stereo);
    TEST_ASSERT(repeat == 1U);
    TEST_ASSERT(channel == 0);
    TEST_ASSERT(!stopCurrentSound);
    TEST_ASSERT(queuedCount < 2U);
    if (rejectNext) {
      rejectNext = false;
      return false;
    }
    queued[queuedCount++] = samples;
    return true;
  }

  void completeOne() {
    TEST_ASSERT(queuedCount > 0U);
    queued[0] = queued[1];
    queued[1] = nullptr;
    --queuedCount;
  }

  void flush() {
    queued[0] = nullptr;
    queued[1] = nullptr;
    queuedCount = 0U;
  }
};

using Playback =
    iterate::kit::platforms::BoundedPlayback<
        sampleCount,
        16'000U>;

/*
 * The speaker library retains raw PCM pointers asynchronously, so dequeuing
 * directly into one scratch buffer would overwrite audio still being played.
 * Copying into an unbounded playback queue avoids that race but turns network
 * bursts into delayed speech. This scenario fills the speaker's bounded
 * ownership window and proves a third lane frame remains queued until hardware
 * completes one buffer, with ownership depth reported precisely.
 */
void preservesEverySpeakerOwnedBuffer() {
  /*
   * Three local frames cover the adapter's fixed ownership states; more storage
   * would hide latency as a private speaker backlog and consume scarce internal
   * RAM. The metadata allowance accommodates indices/counters without licensing
   * another PCM-sized allocation. Keep this compile-time gate close to the
   * ownership test so changes to the buffering model require explicit review.
   */
  static_assert(
      sizeof(Playback) <=
          3U * frameBytes + 128U,
      "playback must remain three PCM frames plus small metadata");
  LaneFixture fixture;
  FakeSpeaker speaker;
  Playback playback;
  TEST_ASSERT(playback.prepare(speaker) == ITERATE_KIT_OK);
  fixture.publish(11);
  fixture.publish(22);
  fixture.publish(33);

  auto result = playback.pump(fixture.lane, speaker);
  TEST_ASSERT(result.status == ITERATE_KIT_OK);
  TEST_ASSERT(result.frameSubmitted);
  TEST_ASSERT(speaker.queuedCount == 1U);
  TEST_ASSERT(speaker.queued[0][0] == 11);

  result = playback.pump(fixture.lane, speaker);
  TEST_ASSERT(result.status == ITERATE_KIT_OK);
  TEST_ASSERT(result.frameSubmitted);
  TEST_ASSERT(speaker.queuedCount == 2U);
  TEST_ASSERT(speaker.queued[0][0] == 11);
  TEST_ASSERT(speaker.queued[1][0] == 22);

  result = playback.pump(fixture.lane, speaker);
  TEST_ASSERT(result.status == ITERATE_KIT_OK);
  TEST_ASSERT(!result.frameSubmitted);
  TEST_ASSERT(speaker.queued[0][0] == 11);
  TEST_ASSERT(speaker.queued[1][0] == 22);

  struct iterate_kit_pcm_lane_metrics laneMetrics{};
  iterate_kit_pcm_lane_metrics(&fixture.lane, &laneMetrics);
  TEST_ASSERT(laneMetrics.downlink.current_slots == 1U);

  speaker.completeOne();
  result = playback.pump(fixture.lane, speaker);
  TEST_ASSERT(result.status == ITERATE_KIT_OK);
  TEST_ASSERT(result.frameSubmitted);
  TEST_ASSERT(speaker.queuedCount == 2U);
  TEST_ASSERT(speaker.queued[0][0] == 22);
  TEST_ASSERT(speaker.queued[1][0] == 33);

  const auto metrics = playback.metrics();
  TEST_ASSERT(metrics.framesDequeued == 3U);
  TEST_ASSERT(metrics.framesSubmitted == 3U);
  TEST_ASSERT(metrics.framesCompleted == 1U);
  TEST_ASSERT(metrics.submitFailures == 0U);
  TEST_ASSERT(metrics.currentOwnedBuffers == 2U);
  TEST_ASSERT(metrics.highWaterOwnedBuffers == 2U);
}

/*
 * Hardware may transiently reject playRaw after the lane frame has already
 * moved into adapter-owned storage. Reacquiring the lane on retry would either
 * skip that audio or duplicate the next frame, while dropping immediately
 * creates an unnecessary audible hole. This test proves the one rejected frame
 * remains in the bounded local slot and is retried exactly once without
 * altering lane-consumption accounting.
 */
void retainsARejectedSubmissionWithoutReacquiringTheLane() {
  LaneFixture fixture;
  FakeSpeaker speaker;
  Playback playback;
  TEST_ASSERT(playback.prepare(speaker) == ITERATE_KIT_OK);
  fixture.publish(47);
  speaker.rejectNext = true;

  auto result = playback.pump(fixture.lane, speaker);
  TEST_ASSERT(result.status == ITERATE_KIT_UNAVAILABLE);
  TEST_ASSERT(!result.frameSubmitted);
  TEST_ASSERT(speaker.queuedCount == 0U);

  struct iterate_kit_pcm_lane_metrics laneMetrics{};
  iterate_kit_pcm_lane_metrics(&fixture.lane, &laneMetrics);
  TEST_ASSERT(laneMetrics.downlink.current_slots == 0U);
  TEST_ASSERT(laneMetrics.downlink.messages_consumed == 1U);

  result = playback.pump(fixture.lane, speaker);
  TEST_ASSERT(result.status == ITERATE_KIT_OK);
  TEST_ASSERT(result.frameSubmitted);
  TEST_ASSERT(speaker.queuedCount == 1U);
  TEST_ASSERT(speaker.queued[0][0] == 47);

  const auto metrics = playback.metrics();
  TEST_ASSERT(metrics.framesDequeued == 1U);
  TEST_ASSERT(metrics.framesSubmitted == 1U);
  TEST_ASSERT(metrics.submitFailures == 1U);
}

/*
 * Interruption flushes the physical speaker queue before a new conversational
 * epoch starts. Merely resetting software indices first would reuse buffers
 * while DMA may still read them; never resetting would leak all playback
 * capacity after each interruption. This sequence pins the ordering contract:
 * after confirmed hardware flush, every owned frame is classified as flushed
 * and the same fixed storage can safely serve current audio.
 */
void releasesLocalOwnershipOnlyAfterHardwareFlush() {
  LaneFixture fixture;
  FakeSpeaker speaker;
  Playback playback;
  TEST_ASSERT(playback.prepare(speaker) == ITERATE_KIT_OK);
  fixture.publish(61);
  fixture.publish(62);
  TEST_ASSERT(playback.pump(fixture.lane, speaker).frameSubmitted);
  TEST_ASSERT(playback.pump(fixture.lane, speaker).frameSubmitted);

  speaker.flush();
  playback.resetAfterHardwareFlush();
  TEST_ASSERT(playback.prepare(speaker) == ITERATE_KIT_OK);

  const auto metrics = playback.metrics();
  TEST_ASSERT(metrics.framesFlushed == 2U);
  TEST_ASSERT(metrics.currentOwnedBuffers == 0U);

  fixture.publish(63);
  const auto result = playback.pump(fixture.lane, speaker);
  TEST_ASSERT(result.status == ITERATE_KIT_OK);
  TEST_ASSERT(result.frameSubmitted);
  TEST_ASSERT(speaker.queued[0][0] == 63);
}

/*
 * The WebSocket/lane boundary promises fixed-size PCM, but corruption or a
 * future refactor could bypass that validator. Padding a short frame in the
 * speaker adapter would conceal an internal invariant violation and make
 * diagnostics claim healthy playback. This deliberately malformed storage
 * envelope proves the lane consumes the poison slot before exposing a pointer,
 * while playback still records the resulting state error instead of wedging.
 */
void classifiesAnImpossibleShortLaneFrame() {
  LaneFixture fixture;
  FakeSpeaker speaker;
  Playback playback;
  TEST_ASSERT(playback.prepare(speaker) == ITERATE_KIT_OK);
  void *destination = nullptr;
  std::size_t capacity = 0U;
  TEST_ASSERT(
      iterate_kit_spsc_ring_write_acquire(
          &fixture.downlinkRing,
          &destination,
          &capacity) == ITERATE_KIT_OK);
  /*
   * The downlink slot also carries receive-time metadata. This corruption
   * seam intentionally bypasses the lane API, so it may depend only on enough
   * capacity for the malformed byte—not on the private slot layout.
   */
  TEST_ASSERT(capacity >= 1U);
  static_cast<std::uint8_t *>(destination)[0] = 1U;
  TEST_ASSERT(
      iterate_kit_spsc_ring_write_publish(
          &fixture.downlinkRing, 1U) == ITERATE_KIT_OK);

  const auto result = playback.pump(fixture.lane, speaker);
  TEST_ASSERT(result.status == ITERATE_KIT_STATE_ERROR);
  TEST_ASSERT(!result.frameSubmitted);
  TEST_ASSERT(playback.metrics().invalidFrames == 0U);
  TEST_ASSERT(playback.metrics().stateErrors == 1U);

  struct iterate_kit_pcm_lane_metrics laneMetrics{};
  iterate_kit_pcm_lane_metrics(&fixture.lane, &laneMetrics);
  TEST_ASSERT(laneMetrics.downlink.current_slots == 0U);
}

/*
 * Speaker initialization can fail transiently while downlink PCM is already
 * available. Dequeuing before begin succeeds would force either an extra retry
 * buffer or silent loss, and retrying begin in the realtime pump could block
 * audio scheduling. This test protects the lifecycle boundary: the lane keeps
 * ownership across failed preparation and releases the frame only after
 * hardware is ready to accept it immediately.
 */
void doesNotDequeueUntilSpeakerStartupCompletes() {
  LaneFixture fixture;
  FakeSpeaker speaker;
  Playback playback;
  fixture.publish(71);

  auto result = playback.pump(fixture.lane, speaker);
  TEST_ASSERT(result.status == ITERATE_KIT_UNAVAILABLE);
  TEST_ASSERT(!result.frameSubmitted);

  struct iterate_kit_pcm_lane_metrics laneMetrics{};
  iterate_kit_pcm_lane_metrics(&fixture.lane, &laneMetrics);
  TEST_ASSERT(laneMetrics.downlink.current_slots == 1U);

  speaker.beginResult = false;
  TEST_ASSERT(playback.prepare(speaker) == ITERATE_KIT_IO_ERROR);
  TEST_ASSERT(playback.metrics().prepareFailures == 1U);
  iterate_kit_pcm_lane_metrics(&fixture.lane, &laneMetrics);
  TEST_ASSERT(laneMetrics.downlink.current_slots == 1U);

  speaker.beginResult = true;
  TEST_ASSERT(playback.prepare(speaker) == ITERATE_KIT_OK);
  result = playback.pump(fixture.lane, speaker);
  TEST_ASSERT(result.status == ITERATE_KIT_OK);
  TEST_ASSERT(result.frameSubmitted);
  TEST_ASSERT(speaker.queued[0][0] == 71);
}

}  // namespace

int main() {
  preservesEverySpeakerOwnedBuffer();
  retainsARejectedSubmissionWithoutReacquiringTheLane();
  releasesLocalOwnershipOnlyAfterHardwareFlush();
  classifiesAnImpossibleShortLaneFrame();
  doesNotDequeueUntilSpeakerStartupCompletes();
  return 0;
}
