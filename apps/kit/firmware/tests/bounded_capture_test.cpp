#include "iterate/kit/platforms/bounded_capture.hpp"

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

struct FakeRecorder {
  static constexpr std::size_t capacity = 2U;
  std::int16_t *borrowedSamples[capacity]{};
  std::size_t borrowedSampleCounts[capacity]{};
  std::size_t head = 0U;
  std::size_t pendingCount = 0U;
  std::size_t recordCount = 0U;

  std::size_t isRecording() const {
    return pendingCount;
  }

  bool record(
      std::int16_t *samples,
      std::size_t sampleCount,
      std::uint32_t sampleRate,
      bool stereo) {
    TEST_ASSERT(pendingCount < capacity);
    TEST_ASSERT(sampleRate == 16'000U);
    TEST_ASSERT(!stereo);
    const std::size_t tail = (head + pendingCount) % capacity;
    for (std::size_t index = 0U; index < pendingCount; ++index) {
      TEST_ASSERT(
          borrowedSamples[(head + index) % capacity] != samples);
    }
    borrowedSamples[tail] = samples;
    borrowedSampleCounts[tail] = sampleCount;
    ++pendingCount;
    ++recordCount;
    return true;
  }

  void complete(std::int16_t value) {
    TEST_ASSERT(pendingCount > 0U);
    std::int16_t *const samples = borrowedSamples[head];
    const std::size_t sampleCount = borrowedSampleCounts[head];
    for (std::size_t index = 0U;
         index < sampleCount;
         ++index) {
      samples[index] = value;
    }
    borrowedSamples[head] = nullptr;
    borrowedSampleCounts[head] = 0U;
    head = (head + 1U) % capacity;
    --pendingCount;
  }

  void stop() {
    for (std::size_t index = 0U; index < capacity; ++index) {
      borrowedSamples[index] = nullptr;
      borrowedSampleCounts[index] = 0U;
    }
    head = 0U;
    pendingCount = 0U;
  }
};

struct FakeEgress {
  std::size_t sendCount = 0U;
  std::int16_t firstSample = 0;
  iterate_kit_audio_send_complete_fn complete = nullptr;
  void *completeContext = nullptr;
};

iterate_kit_status okHardware(void *) {
  return ITERATE_KIT_OK;
}

iterate_kit_status discardEvent(
    void *, iterate_kit_audio_event) {
  return ITERATE_KIT_OK;
}

iterate_kit_status sendPcm(
    void *context,
    const std::int16_t *samples,
    std::size_t sampleCount,
    std::uint32_t sampleRate,
    iterate_kit_audio_send_complete_fn complete,
    void *completeContext) {
  auto &egress = *static_cast<FakeEgress *>(context);
  TEST_ASSERT(samples != nullptr);
  TEST_ASSERT(sampleCount == 320U);
  TEST_ASSERT(sampleRate == 16'000U);
  TEST_ASSERT(egress.complete == nullptr);
  ++egress.sendCount;
  egress.firstSample = samples[0];
  egress.complete = complete;
  egress.completeContext = completeContext;
  return ITERATE_KIT_OK;
}

void completeSend(FakeEgress &egress) {
  TEST_ASSERT(egress.complete != nullptr);
  const auto complete = egress.complete;
  void *const context = egress.completeContext;
  egress.complete = nullptr;
  egress.completeContext = nullptr;
  complete(context, ITERATE_KIT_OK);
}

iterate_kit_status submitCapture(
    void *context,
    const std::int16_t *samples,
    std::size_t sampleCount,
    std::uint32_t sampleRate) {
  return iterate_kit_audio_submit_capture(
      static_cast<iterate_kit_audio_controller *>(context),
      samples,
      sampleCount,
      sampleRate);
}

iterate_kit_status idleCapture(
    void *,
    iterate_kit_audio_capture_submit_fn,
    void *) {
  return ITERATE_KIT_OK;
}

iterate_kit_audio_controller makeController(FakeEgress &egress) {
  iterate_kit_audio_controller controller{};
  const iterate_kit_audio_options options{
    ITERATE_KIT_AUDIO_PUSH_TO_TALK,
    {
      nullptr,
      okHardware,
      okHardware,
      okHardware,
      okHardware,
    },
    {
      &egress,
      discardEvent,
      sendPcm,
    },
    {
      nullptr,
      idleCapture,
    },
  };
  TEST_ASSERT(
      iterate_kit_audio_controller_init(&controller, &options) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(
      iterate_kit_audio_push_to_talk(&controller, true) ==
      ITERATE_KIT_OK);
  return controller;
}

/*
 * The M5 recorder can complete a priming buffer containing codec/I2S startup
 * residue, but discarding until the queue “looks stable” would silently eat an
 * unbounded beginning of the user's PTT utterance. The capture adapter accepts
 * an explicit one-frame warmup policy per epoch instead. This scenario proves
 * exactly that frame is discarded, later audio is sent, and the two recorder
 * buffers stay continuously armed without creating an extra queue.
 */
void discardsOnlyTheBoundedCodecWarmupFrame() {
  using Capture =
      iterate::kit::platforms::BoundedCapture<320U, 16'000U>;
  /*
   * Two buffers are the ownership bridge for the recorder's asynchronous API.
   * Accidental queues or per-instance scratch space here are especially costly
   * because every byte is internal RAM and can lengthen the microphone backlog.
   * Allow only two PCM frames plus small bookkeeping; the size gate makes that
   * resource contract fail at compile time.
   */
  static_assert(
      sizeof(Capture) <=
          2U * 320U * sizeof(std::int16_t) + 32U,
      "bounded capture state must remain essentially two PCM frames");
  FakeRecorder recorder;
  FakeEgress egress;
  auto controller = makeController(egress);
  Capture capture;
  capture.start(1U);

  TEST_ASSERT(
      capture.pump(recorder, submitCapture, &controller) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(recorder.recordCount == 2U);
  TEST_ASSERT(recorder.isRecording() == 2U);
  TEST_ASSERT(egress.sendCount == 0U);

  recorder.complete(0);
  TEST_ASSERT(
      capture.pump(recorder, submitCapture, &controller) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(egress.sendCount == 0U);
  TEST_ASSERT(!controller.capture_frame_in_flight);
  TEST_ASSERT(recorder.recordCount == 3U);
  TEST_ASSERT(recorder.isRecording() == 2U);
  recorder.complete(123);
  TEST_ASSERT(
      capture.pump(recorder, submitCapture, &controller) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(egress.sendCount == 1U);
  TEST_ASSERT(egress.firstSample == 123);
  TEST_ASSERT(controller.capture_frame_in_flight);

  completeSend(egress);
  TEST_ASSERT(
      capture.pump(recorder, submitCapture, &controller) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(recorder.recordCount == 4U);
  TEST_ASSERT(recorder.isRecording() == 2U);
}

/*
 * Stopping and restarting PTT reinitializes the physical recorder, so codec
 * warmup is an epoch property rather than a once-per-boot event. Remembering
 * the old discard count would leak startup residue from later presses; failing
 * to bound it could discard real speech repeatedly. This test proves each
 * capture start receives exactly its independently configured warmup allowance.
 */
void resetsTheWarmupBoundOnEveryCaptureStart() {
  using Capture =
      iterate::kit::platforms::BoundedCapture<320U, 16'000U>;
  FakeRecorder recorder;
  FakeEgress egress;
  auto controller = makeController(egress);
  Capture capture;

  capture.start(1U);
  TEST_ASSERT(
      capture.pump(recorder, submitCapture, &controller) ==
      ITERATE_KIT_OK);
  recorder.complete(1);
  TEST_ASSERT(
      capture.pump(recorder, submitCapture, &controller) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(egress.sendCount == 0U);

  recorder.stop();
  capture.stop();
  capture.start(1U);
  TEST_ASSERT(
      capture.pump(recorder, submitCapture, &controller) ==
      ITERATE_KIT_OK);
  recorder.complete(2);
  TEST_ASSERT(
      capture.pump(recorder, submitCapture, &controller) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(egress.sendCount == 0U);
}

/*
 * A long button hold must stream microphone frames continuously rather than
 * record only on press/release or wait for the network loop to request each
 * chunk. Arming one buffer at a time leaves an avoidable gap while callbacks
 * and egress completion are serviced, whereas a deeper queue adds latency and
 * RAM. This sustained run pins the two-buffer pipeline: one completion is sent
 * and its freed slot is rearmed as soon as ownership permits.
 */
void keepsTheRecorderQueueArmedDuringSustainedCapture() {
  using Capture =
      iterate::kit::platforms::BoundedCapture<320U, 16'000U>;
  FakeRecorder recorder;
  FakeEgress egress;
  auto controller = makeController(egress);
  Capture capture;
  capture.start(0U);

  TEST_ASSERT(
      capture.pump(recorder, submitCapture, &controller) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(recorder.isRecording() == FakeRecorder::capacity);
  TEST_ASSERT(recorder.recordCount == FakeRecorder::capacity);

  for (std::int16_t value = 1; value <= 8; ++value) {
    recorder.complete(value);
    TEST_ASSERT(
        capture.pump(recorder, submitCapture, &controller) ==
        ITERATE_KIT_OK);
    TEST_ASSERT(egress.firstSample == value);
    TEST_ASSERT(recorder.isRecording() == 1U);

    completeSend(egress);
    TEST_ASSERT(
        capture.pump(recorder, submitCapture, &controller) ==
        ITERATE_KIT_OK);
    TEST_ASSERT(recorder.isRecording() == FakeRecorder::capacity);
  }
  TEST_ASSERT(egress.sendCount == 8U);
}

}  // namespace

int main() {
  discardsOnlyTheBoundedCodecWarmupFrame();
  resetsTheWarmupBoundOnEveryCaptureStart();
  keepsTheRecorderQueueArmedDuringSustainedCapture();
  return 0;
}
