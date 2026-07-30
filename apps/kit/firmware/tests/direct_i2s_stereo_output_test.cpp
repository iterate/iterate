#include "iterate/kit/platforms/direct_i2s_stereo_output.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <type_traits>

namespace {

const char *currentTest = "test initialization";

void testAssert(
    bool condition,
    const char *expression,
    const char *file,
    int line) {
  if (condition) return;
  std::fprintf(
      stderr,
      "%s:%d: %s assertion failed: %s\n",
      file,
      line,
      currentTest,
      expression);
  std::abort();
}

#define TEST_ASSERT(expression) \
  testAssert((expression), #expression, __FILE__, __LINE__)
#define RUN_TEST(function) \
  do { \
    currentTest = #function; \
    function(); \
  } while (false)

constexpr std::size_t monoSampleCount = 320U;
constexpr std::size_t descriptorCount = 4U;
constexpr std::size_t stereoSampleCount =
    monoSampleCount * 2U;
constexpr std::size_t stereoFrameBytes =
    stereoSampleCount * sizeof(std::int16_t);

using iterate::kit::platforms::DirectI2sBackendCompletionBatch;
using iterate::kit::platforms::DirectI2sBackendCompletion;
using iterate::kit::platforms::DirectI2sDescriptorToken;
using iterate::kit::platforms::DirectI2sTransferResult;

/*
 * This fake models the narrow synchronous-copy boundary an ESP-IDF adapter
 * must implement. Fixed arrays are intentional: a heap-using fake could let
 * allocation creep into the production contract while every host test still
 * looked healthy.
 */
struct FakeDirectI2sBackend {
  static constexpr std::size_t historyCapacity = 32U;
  static constexpr bool clearsDmaBeforeEofCallback = true;

  std::array<
      DirectI2sBackendCompletion,
      descriptorCount> completionQueue{};
  /*
   * ESP-IDF separately creates its private finished-buffer write queue with
   * `dma_desc_num - 1` entries. Draining our callback observations does not
   * drain this queue: only i2s_channel_write(), or an explicit adapter drain,
   * consumes the pointer used for the actual copy.
   */
  std::array<
      DirectI2sDescriptorToken,
      descriptorCount - 1U> driverWriteQueue{};
  std::array<DirectI2sDescriptorToken, historyCapacity>
      preloadHistory{};
  std::array<DirectI2sDescriptorToken, historyCapacity>
      writeAttemptHistory{};
  std::array<std::int16_t, historyCapacity> firstLeftHistory{};
  std::array<std::int16_t, historyCapacity> lastRightHistory{};
  std::size_t completionCount = 0U;
  std::size_t driverWriteQueueCount = 0U;
  std::size_t preloadHistoryCount = 0U;
  std::size_t writeAttemptHistoryCount = 0U;
  std::size_t observedStereoFrameCount = 0U;
  std::size_t currentPreloadIndex = 0U;
  std::uint32_t generation = 0U;
  std::uint32_t resetCount = 0U;
  std::uint32_t startCount = 0U;
  std::uint32_t stopCount = 0U;
  std::uint32_t queueOverflows = 0U;
  std::uint32_t ownerLagUs = 300U;
  iterate::kit::platforms::
      RealtimePlaybackSuccessfulRefillTiming
          refillTiming{
            true, 450U, 75U, 59'550U};
  DirectI2sTransferResult nextPreloadResult{
      ITERATE_KIT_OK, stereoFrameBytes,
      DirectI2sDescriptorToken{0U}};
  DirectI2sTransferResult nextWriteResult{
      ITERATE_KIT_OK, stereoFrameBytes,
      DirectI2sDescriptorToken{0U}};
  bool useCustomPreloadResult = false;
  bool useCustomWriteResult = false;
  bool consumePrivateQueueOnWrite = true;
  bool running = false;
  bool released = true;
  bool allObservedFramesWereInterleavedStereo = true;

  static DirectI2sDescriptorToken token(
      std::uint32_t generationValue,
      std::size_t descriptorIndex) {
    return DirectI2sDescriptorToken{
      static_cast<std::uintptr_t>(
          generationValue * 16U + descriptorIndex)};
  }

  iterate_kit_status resetForPlayback() {
    /*
     * A real reset must delete the old channel rather than merely resetting a
     * software cursor. Advancing the token generation lets tests detect any
     * stale EOF identity that survives this destructive boundary.
     */
    ++resetCount;
    ++generation;
    completionCount = 0U;
    driverWriteQueueCount = 0U;
    currentPreloadIndex = 0U;
    queueOverflows = 0U;
    running = false;
    released = false;
    return ITERATE_KIT_OK;
  }

  DirectI2sTransferResult preloadStereo(
      const std::int16_t *samples,
      std::size_t bytes) {
    TEST_ASSERT(!running);
    TEST_ASSERT(!released);
    TEST_ASSERT(bytes == stereoFrameBytes);
    observeStereo(samples);
    const auto descriptor =
        token(generation, currentPreloadIndex);
    TEST_ASSERT(preloadHistoryCount < preloadHistory.size());
    preloadHistory[preloadHistoryCount++] = descriptor;

    auto result = DirectI2sTransferResult{
      ITERATE_KIT_OK, bytes, descriptor};
    if (useCustomPreloadResult) {
      result = nextPreloadResult;
      result.descriptor = descriptor;
      useCustomPreloadResult = false;
    }
    if (result.status == ITERATE_KIT_OK &&
        result.bytesTransferred == bytes) {
      ++currentPreloadIndex;
    }
    return result;
  }

  iterate_kit_status startPlayback() {
    TEST_ASSERT(currentPreloadIndex == descriptorCount);
    TEST_ASSERT(!released);
    ++startCount;
    running = true;
    return ITERATE_KIT_OK;
  }

  DirectI2sBackendCompletionBatch takeCompletedDescriptors(
      DirectI2sBackendCompletion *destination,
      std::size_t capacity) {
    TEST_ASSERT(destination != nullptr);
    TEST_ASSERT(completionCount <= capacity);
    for (std::size_t index = 0U;
         index < completionCount;
         ++index) {
      destination[index] = completionQueue[index];
    }
    const auto reuseLeadBeforeOwnerLag =
        static_cast<std::uint32_t>(
            (descriptorCount - driverWriteQueueCount) *
            20'000U);
    const auto result = DirectI2sBackendCompletionBatch{
      completionCount,
      driverWriteQueueCount > 0U,
      ownerLagUs,
      ownerLagUs >= reuseLeadBeforeOwnerLag
          ? 0U
          : reuseLeadBeforeOwnerLag - ownerLagUs};
    completionCount = 0U;
    return result;
  }

  DirectI2sTransferResult writeStereo(
      DirectI2sDescriptorToken descriptor,
      const std::int16_t *samples,
      std::size_t bytes) {
    TEST_ASSERT(running);
    TEST_ASSERT(bytes == stereoFrameBytes);
    observeStereo(samples);
    TEST_ASSERT(
        writeAttemptHistoryCount <
        writeAttemptHistory.size());
    writeAttemptHistory[writeAttemptHistoryCount++] =
        descriptor;

    auto result = DirectI2sTransferResult{
      ITERATE_KIT_OK, bytes, descriptor};
    if (useCustomWriteResult) {
      result = nextWriteResult;
      result.descriptor = descriptor;
      useCustomWriteResult = false;
    }
    if (consumePrivateQueueOnWrite &&
        result.status == ITERATE_KIT_OK &&
        result.bytesTransferred == bytes) {
      TEST_ASSERT(driverWriteQueueCount > 0U);
      TEST_ASSERT(driverWriteQueue[0] == descriptor);
      for (std::size_t index = 1U;
           index < driverWriteQueueCount;
           ++index) {
        driverWriteQueue[index - 1U] =
            driverWriteQueue[index];
      }
      --driverWriteQueueCount;
    }
    return result;
  }

  std::uint32_t takeQueueOverflows() {
    const auto result = queueOverflows;
    queueOverflows = 0U;
    return result;
  }

  iterate::kit::platforms::
      RealtimePlaybackSuccessfulRefillTiming
  lastSuccessfulRefillTiming() const {
    return refillTiming;
  }

  iterate_kit_status stopAndRelease() {
    ++stopCount;
    completionCount = 0U;
    driverWriteQueueCount = 0U;
    currentPreloadIndex = 0U;
    running = false;
    released = true;
    return ITERATE_KIT_OK;
  }

  void complete(
      DirectI2sDescriptorToken descriptor,
      std::uint64_t eofAtUs = 0U) {
    TEST_ASSERT(completionCount < completionQueue.size());
    completionQueue[completionCount++] = {
      descriptor, eofAtUs};

    if (driverWriteQueueCount ==
        driverWriteQueue.size()) {
      for (std::size_t index = 1U;
           index < driverWriteQueue.size();
           ++index) {
        driverWriteQueue[index - 1U] =
            driverWriteQueue[index];
      }
      --driverWriteQueueCount;
      ++queueOverflows;
    }
    driverWriteQueue[driverWriteQueueCount++] =
        descriptor;
  }

  void observeStereo(const std::int16_t *samples) {
    TEST_ASSERT(samples != nullptr);
    for (std::size_t index = 0U;
         index < monoSampleCount;
         ++index) {
      if (samples[index * 2U] !=
          samples[index * 2U + 1U]) {
        allObservedFramesWereInterleavedStereo = false;
      }
    }
    TEST_ASSERT(
        observedStereoFrameCount <
        firstLeftHistory.size());
    firstLeftHistory[observedStereoFrameCount] =
        samples[0];
    lastRightHistory[observedStereoFrameCount] =
        samples[stereoSampleCount - 1U];
    ++observedStereoFrameCount;
  }
};

using Output =
    iterate::kit::platforms::DirectI2sStereoOutput<
        monoSampleCount,
        descriptorCount,
        FakeDirectI2sBackend>;

std::array<std::int16_t, monoSampleCount> frame(
    std::int16_t first,
    std::int16_t last) {
  std::array<std::int16_t, monoSampleCount> result{};
  result.fill(first);
  result.back() = last;
  return result;
}

void preloadAndStart(
    Output &output,
    FakeDirectI2sBackend &backend) {
  TEST_ASSERT(output.resetForPlayback() == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    const auto samples = frame(value, -value);
    TEST_ASSERT(
        output.preloadMono(
            samples.data(), samples.size()) ==
        ITERATE_KIT_OK);
  }
  TEST_ASSERT(output.start() == ITERATE_KIT_OK);
  TEST_ASSERT(backend.running);
}

/*
 * Cyclic DMA is not a count-only FIFO: after descriptor 3, hardware reuses
 * descriptor 0. Losing those identities can overwrite a descriptor that is
 * still audible while tests based only on four anonymous credits remain
 * green. Exercise the largest legal IDF callback batch (0/1/2), leave token 2
 * pending while token 3 arrives, then repeat across a wrap. This catches ring
 * head/append bugs that draining one EOF at a time cannot expose.
 */
void descriptorIdentitySurvivesOrderedWraps() {
  FakeDirectI2sBackend backend;
  Output output(backend);
  TEST_ASSERT(output.resetForPlayback() == ITERATE_KIT_OK);
  for (std::uint32_t index = 0U;
       index < descriptorCount;
       ++index) {
    const auto samples = frame(
        static_cast<std::int16_t>(index + 1U),
        static_cast<std::int16_t>(-(index + 1)));
    TEST_ASSERT(
        output.preloadMono(
            samples.data(),
            samples.size(),
            iterate::kit::platforms::
                DirectI2sFrameMetadata{
                  100U, 5U, index}) ==
        ITERATE_KIT_OK);
  }
  TEST_ASSERT(output.start() == ITERATE_KIT_OK);

  for (std::size_t cycle = 0U; cycle < 2U; ++cycle) {
    for (std::size_t index = 0U; index < 3U; ++index) {
      backend.complete(
          FakeDirectI2sBackend::token(
              backend.generation, index));
    }
    const auto firstBatch = output.takeCompletionBatch();
    TEST_ASSERT(
        firstBatch.newlyCompletedDescriptorCount == 3U);
    TEST_ASSERT(
        firstBatch.pendingRefillDescriptorCount == 3U);
    TEST_ASSERT(firstBatch.timingValid);
    TEST_ASSERT(firstBatch.earliestReuseLeadUs == 19'700U);
    for (std::size_t index = 0U; index < 3U; ++index) {
      iterate::kit::platforms::
          DirectI2sDescriptorCompletion completion{};
      TEST_ASSERT(output.lastCompletion(index, &completion));
      TEST_ASSERT(
          completion.frame.sequence ==
          cycle * descriptorCount + index);
    }

    for (std::size_t index = 0U; index < 2U; ++index) {
      const auto value =
          static_cast<std::int16_t>(
              10U + cycle * descriptorCount + index);
      const auto samples = frame(value, -value);
      TEST_ASSERT(
          output.writeMono(
              samples.data(),
              samples.size(),
              iterate::kit::platforms::
                  DirectI2sFrameMetadata{
                    180U,
                    5U,
                    static_cast<std::uint32_t>(
                        (cycle + 1U) *
                            descriptorCount +
                        index)}) ==
          ITERATE_KIT_OK);
    }

    backend.complete(
        FakeDirectI2sBackend::token(
            backend.generation, 3U));
    const auto secondBatch = output.takeCompletionBatch();
    TEST_ASSERT(
        secondBatch.newlyCompletedDescriptorCount == 1U);
    TEST_ASSERT(
        secondBatch.pendingRefillDescriptorCount == 2U);
    TEST_ASSERT(
        secondBatch.earliestReuseLeadUs == 39'700U);
    iterate::kit::platforms::
        DirectI2sDescriptorCompletion fourth{};
    TEST_ASSERT(output.lastCompletion(0U, &fourth));
    TEST_ASSERT(
        fourth.frame.sequence ==
        cycle * descriptorCount + 3U);

    for (std::size_t index = 2U;
         index < descriptorCount;
         ++index) {
      const auto value =
          static_cast<std::int16_t>(
              10U + cycle * descriptorCount + index);
      const auto samples = frame(value, -value);
      TEST_ASSERT(
          output.writeMono(
              samples.data(),
              samples.size(),
              iterate::kit::platforms::
                  DirectI2sFrameMetadata{
                    180U,
                    5U,
                    static_cast<std::uint32_t>(
                        (cycle + 1U) *
                            descriptorCount +
                        index)}) ==
          ITERATE_KIT_OK);
    }
  }

  TEST_ASSERT(backend.writeAttemptHistoryCount == 8U);
  for (std::size_t index = 0U; index < 8U; ++index) {
    TEST_ASSERT(
        backend.writeAttemptHistory[index] ==
        FakeDirectI2sBackend::token(
            backend.generation,
            index % descriptorCount));
  }
  TEST_ASSERT(backend.allObservedFramesWereInterleavedStereo);
  TEST_ASSERT(backend.firstLeftHistory[0] == 1);
  TEST_ASSERT(backend.lastRightHistory[0] == -1);
  TEST_ASSERT(backend.firstLeftHistory[11] == 17);
  TEST_ASSERT(backend.lastRightHistory[11] == -17);
  TEST_ASSERT(output.stopAndRelease() == ITERATE_KIT_OK);
  TEST_ASSERT(backend.released);
  TEST_ASSERT(!backend.running);
  TEST_ASSERT(
      output.state() ==
      iterate::kit::platforms::
          DirectI2sStereoOutputState::released);
}

/*
 * Once callback observations have been drained, an unfilled descriptor still
 * owns a cyclic reuse deadline. A backend that reports "time to next EOF"
 * instead of "time until the oldest pending descriptor is selected again"
 * can look healthy while a retained zero-byte write is already late. Advance
 * owner lag with no new EOFs and require the same pending ownership count with
 * a monotonically shrinking, eventually-zero reuse lead.
 */
void pendingDescriptorDeadlineDecaysWithoutNewEof() {
  FakeDirectI2sBackend backend;
  Output output(backend);
  preloadAndStart(output, backend);
  for (std::size_t index = 0U; index < 3U; ++index) {
    backend.complete(
        FakeDirectI2sBackend::token(
            backend.generation, index));
  }
  const auto initial = output.takeCompletionBatch();
  TEST_ASSERT(
      initial.newlyCompletedDescriptorCount == 3U);
  TEST_ASSERT(initial.pendingRefillDescriptorCount == 3U);
  TEST_ASSERT(initial.earliestReuseLeadUs == 19'700U);

  backend.ownerLagUs = 5'000U;
  const auto later = output.takeCompletionBatch();
  TEST_ASSERT(later.newlyCompletedDescriptorCount == 0U);
  TEST_ASSERT(later.pendingRefillDescriptorCount == 3U);
  TEST_ASSERT(later.timingValid);
  TEST_ASSERT(later.earliestReuseLeadUs == 15'000U);

  backend.ownerLagUs = 25'000U;
  const auto late = output.takeCompletionBatch();
  TEST_ASSERT(late.newlyCompletedDescriptorCount == 0U);
  TEST_ASSERT(late.pendingRefillDescriptorCount == 3U);
  TEST_ASSERT(late.earliestReuseLeadUs == 0U);
}

/*
 * The portable playback policy sits above this mono-to-stereo adapter, while
 * only the backend can timestamp the actual driver return. Forward the exact
 * successful refill tuple without recomputing it from the earlier completion
 * poll; recomputation would erase stereo-copy/write duration from the SLO.
 */
void successfulRefillTimingIsForwardedFromTheExactWrite() {
  FakeDirectI2sBackend backend;
  Output output(backend);
  preloadAndStart(output, backend);
  backend.complete(
      FakeDirectI2sBackend::token(
          backend.generation, 0U));
  TEST_ASSERT(
      output.pollCompletionBatch().status ==
      ITERATE_KIT_OK);
  backend.refillTiming = {
    true, 875U, 125U, 59'125U};
  const auto samples = frame(9, -9);

  TEST_ASSERT(
      output.writeMono(
          samples.data(), samples.size()) ==
      ITERATE_KIT_OK);
  const auto timing =
      output.lastSuccessfulRefillTiming();
  TEST_ASSERT(timing.valid);
  TEST_ASSERT(timing.eofToSuccessfulRefillUs == 875U);
  TEST_ASSERT(timing.writeCallDurationUs == 125U);
  TEST_ASSERT(
      timing.reuseLeadAtSuccessfulRefillUs == 59'125U);

  TEST_ASSERT(output.resetForPlayback() == ITERATE_KIT_OK);
  TEST_ASSERT(!output.lastSuccessfulRefillTiming().valid);
}

/*
 * Enabling I2S with fewer than four complete descriptors causes hardware to
 * cycle through untouched memory immediately. An early start attempt must
 * neither enable clocks nor poison otherwise-valid preloads; the owner may
 * supply the remaining frame and start the same clean generation.
 */
void startWaitsForFourExactPreloads() {
  FakeDirectI2sBackend backend;
  Output output(backend);
  TEST_ASSERT(output.resetForPlayback() == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 3; ++value) {
    const auto samples = frame(value, -value);
    TEST_ASSERT(
        output.preloadMono(
            samples.data(), samples.size()) ==
        ITERATE_KIT_OK);
  }
  TEST_ASSERT(output.start() == ITERATE_KIT_STATE_ERROR);
  TEST_ASSERT(!backend.running);
  TEST_ASSERT(backend.startCount == 0U);

  const auto fourth = frame(4, -4);
  TEST_ASSERT(
      output.preloadMono(
          fourth.data(), fourth.size()) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(output.start() == ITERATE_KIT_OK);
  TEST_ASSERT(backend.startCount == 1U);
}

/*
 * A one-frame response cannot start a four-descriptor cycle with three stale
 * descriptors. EOS policy pads only the initial reserve with silence, then
 * stops on the last content EOF. Prove padding reuses the fixed scratch buffer
 * and passes through the same full 1,280-byte preload contract.
 */
void finitePrebufferCanBePaddedWithExactSilence() {
  FakeDirectI2sBackend backend;
  Output output(backend);
  TEST_ASSERT(output.resetForPlayback() == ITERATE_KIT_OK);
  const auto content = frame(42, -42);
  TEST_ASSERT(
      output.preloadMono(
          content.data(), content.size()) ==
      ITERATE_KIT_OK);
  for (std::size_t index = 1U;
       index < descriptorCount;
       ++index) {
    TEST_ASSERT(output.preloadSilence() == ITERATE_KIT_OK);
  }
  TEST_ASSERT(output.start() == ITERATE_KIT_OK);
  TEST_ASSERT(backend.observedStereoFrameCount == 4U);
  TEST_ASSERT(backend.firstLeftHistory[0] == 42);
  TEST_ASSERT(backend.lastRightHistory[0] == -42);
  for (std::size_t index = 1U;
       index < descriptorCount;
       ++index) {
    TEST_ASSERT(backend.firstLeftHistory[index] == 0);
    TEST_ASSERT(backend.lastRightHistory[index] == 0);
  }

  /*
   * A delayed owner may receive content and padding EOFs in one legal queue-3
   * batch. Exact per-descriptor kind lets EOS policy count one completed PCM
   * frame while still reconciling ownership of all three descriptors.
   */
  for (std::size_t index = 0U; index < 3U; ++index) {
    backend.complete(
        FakeDirectI2sBackend::token(
            backend.generation, index));
  }
  const auto batch = output.takeCompletionBatch();
  TEST_ASSERT(
      batch.newlyCompletedDescriptorCount == 3U);
  for (std::size_t index = 0U; index < 3U; ++index) {
    iterate::kit::platforms::
        DirectI2sDescriptorCompletion completion{};
    TEST_ASSERT(output.lastCompletion(index, &completion));
    TEST_ASSERT(
        completion.frameKind ==
        (index == 0U
            ? iterate::kit::platforms::
                  DirectI2sFrameKind::content
            : iterate::kit::platforms::
                  DirectI2sFrameKind::paddingSilence));
  }
}

/*
 * Silence is still DMA content. If IDF accepts only part of its descriptor,
 * treating the padding as harmless would permit an old speech tail to play
 * after EOS. Require the same poison/reset behavior as a torn content preload.
 */
void partialSilencePreloadIsNotAcceptedAsPadding() {
  FakeDirectI2sBackend backend;
  Output output(backend);
  TEST_ASSERT(output.resetForPlayback() == ITERATE_KIT_OK);
  backend.nextPreloadResult = {
    ITERATE_KIT_OK,
    stereoFrameBytes - sizeof(std::int16_t),
    DirectI2sDescriptorToken{0U}};
  backend.useCustomPreloadResult = true;

  TEST_ASSERT(
      output.preloadSilence() == ITERATE_KIT_IO_ERROR);
  TEST_ASSERT(
      output.fault() ==
      iterate::kit::platforms::
          DirectI2sStereoOutputFault::partialTransfer);
}

/*
 * ESP-IDF reports how many preload bytes actually entered DMA. Treating a
 * short "successful" copy as one complete frame would start clocks over a
 * partly stale descriptor. The whole generation is therefore poisoned until
 * a destructive reset recreates all descriptors.
 */
void partialPreloadCannotBecomePlayableContent() {
  FakeDirectI2sBackend backend;
  Output output(backend);
  TEST_ASSERT(output.resetForPlayback() == ITERATE_KIT_OK);
  backend.nextPreloadResult = {
    ITERATE_KIT_OK,
    stereoFrameBytes - sizeof(std::int16_t),
    DirectI2sDescriptorToken{0U}};
  backend.useCustomPreloadResult = true;
  const auto samples = frame(7, -7);

  TEST_ASSERT(
      output.preloadMono(samples.data(), samples.size()) ==
      ITERATE_KIT_IO_ERROR);
  TEST_ASSERT(
      output.state() ==
      iterate::kit::platforms::
          DirectI2sStereoOutputState::poisoned);
  TEST_ASSERT(
      output.fault() ==
      iterate::kit::platforms::
          DirectI2sStereoOutputFault::partialTransfer);
  TEST_ASSERT(output.start() == ITERATE_KIT_STATE_ERROR);
}

/*
 * A zero-timeout I2S write may make no progress when the driver queue is
 * temporarily unavailable. Zero bytes leave the completed descriptor safe to
 * retry, so its identity must stay at the head. By contrast, either status
 * with nonzero bytes is an unresumable torn PCM frame and must poison playback.
 */
void nonblockingOutcomesNeverLoseACompletedDescriptor() {
  FakeDirectI2sBackend backend;
  Output output(backend);
  preloadAndStart(output, backend);
  const auto descriptor =
      FakeDirectI2sBackend::token(backend.generation, 0U);
  backend.complete(descriptor);
  TEST_ASSERT(
      output.takeCompletionBatch().
          pendingRefillDescriptorCount == 1U);
  const auto samples = frame(8, -8);

  backend.nextWriteResult = {
    ITERATE_KIT_BACKPRESSURE,
    0U,
    DirectI2sDescriptorToken{0U}};
  backend.useCustomWriteResult = true;
  TEST_ASSERT(
      output.writeMono(samples.data(), samples.size()) ==
      ITERATE_KIT_BACKPRESSURE);
  TEST_ASSERT(output.pendingRefillDescriptorCount() == 1U);

  backend.nextWriteResult = {
    ITERATE_KIT_UNAVAILABLE,
    0U,
    DirectI2sDescriptorToken{0U}};
  backend.useCustomWriteResult = true;
  TEST_ASSERT(
      output.writeMono(samples.data(), samples.size()) ==
      ITERATE_KIT_UNAVAILABLE);
  TEST_ASSERT(output.pendingRefillDescriptorCount() == 1U);

  TEST_ASSERT(
      output.writeMono(samples.data(), samples.size()) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(output.pendingRefillDescriptorCount() == 0U);
  TEST_ASSERT(backend.writeAttemptHistoryCount == 3U);
  TEST_ASSERT(backend.writeAttemptHistory[0] == descriptor);
  TEST_ASSERT(backend.writeAttemptHistory[1] == descriptor);
  TEST_ASSERT(backend.writeAttemptHistory[2] == descriptor);
}

/*
 * Some drivers can report WOULD_BLOCK after copying part of the supplied
 * buffer. Retrying from byte zero would duplicate a prefix; advancing would
 * make the public frame API stateful and vulnerable to scheduling gaps. Both
 * are audible corruption, so a partial nonblocking write is a hard generation
 * fault rather than ordinary backpressure.
 */
void partialNonblockingWritePoisonsTheGeneration() {
  FakeDirectI2sBackend backend;
  Output output(backend);
  preloadAndStart(output, backend);
  backend.complete(
      FakeDirectI2sBackend::token(backend.generation, 0U));
  (void)output.takeCompletionBatch();
  backend.nextWriteResult = {
    ITERATE_KIT_BACKPRESSURE,
    stereoFrameBytes / 2U,
    DirectI2sDescriptorToken{0U}};
  backend.useCustomWriteResult = true;
  const auto samples = frame(9, -9);

  TEST_ASSERT(
      output.writeMono(samples.data(), samples.size()) ==
      ITERATE_KIT_IO_ERROR);
  TEST_ASSERT(
      output.fault() ==
      iterate::kit::platforms::
          DirectI2sStereoOutputFault::partialTransfer);
  TEST_ASSERT(output.pendingRefillDescriptorCount() == 1U);
}

/*
 * An ISR completion queue overflow means at least one descriptor identity and
 * deadline observation was lost. Continuing from the remaining tokens can
 * overwrite a live buffer, so the exact incident count is surfaced and the
 * generation becomes unusable until reset.
 */
void completionQueueOverflowIsVisibleAndFatalToGeneration() {
  FakeDirectI2sBackend backend;
  Output output(backend);
  preloadAndStart(output, backend);
  backend.complete(
      FakeDirectI2sBackend::token(
          backend.generation, 0U));
  backend.complete(
      FakeDirectI2sBackend::token(
          backend.generation, 1U));
  backend.complete(
      FakeDirectI2sBackend::token(
          backend.generation, 2U));
  TEST_ASSERT(backend.queueOverflows == 0U);
  backend.complete(
      FakeDirectI2sBackend::token(
          backend.generation, 3U));

  TEST_ASSERT(backend.completionCount == 4U);
  TEST_ASSERT(backend.driverWriteQueueCount == 3U);
  TEST_ASSERT(
      backend.driverWriteQueue[0] ==
      FakeDirectI2sBackend::token(
          backend.generation, 1U));
  TEST_ASSERT(output.takeQueueOverflows() == 1U);
  TEST_ASSERT(
      output.fault() ==
      iterate::kit::platforms::
          DirectI2sStereoOutputFault::completionQueueOverflow);
  TEST_ASSERT(
      output.state() ==
      iterate::kit::platforms::
          DirectI2sStereoOutputState::poisoned);
}

/*
 * Copying directly into callback `dma_buf` can produce correct samples for
 * three frames while leaving ESP-IDF's separate private queue untouched.
 * Reproduce that tempting implementation: despite draining every callback
 * observation and refilling promptly, the fourth EOF must raise the same
 * queue-overflow fault. A real backend therefore uses
 * i2s_channel_write(timeout=0), or explicitly drains the private queue.
 */
void directMemcpyWithoutPrivateQueueDrainFailsOnFourthEof() {
  FakeDirectI2sBackend backend;
  backend.consumePrivateQueueOnWrite = false;
  Output output(backend);
  preloadAndStart(output, backend);
  for (std::size_t index = 0U; index < 3U; ++index) {
    backend.complete(
        FakeDirectI2sBackend::token(
            backend.generation, index));
    TEST_ASSERT(
        output.takeCompletionBatch().
            newlyCompletedDescriptorCount == 1U);
    const auto samples = frame(50, -50);
    TEST_ASSERT(
        output.writeMono(
            samples.data(), samples.size()) ==
        ITERATE_KIT_OK);
    TEST_ASSERT(backend.queueOverflows == 0U);
  }

  backend.complete(
      FakeDirectI2sBackend::token(
          backend.generation, 3U));
  TEST_ASSERT(output.takeQueueOverflows() == 1U);
  TEST_ASSERT(
      output.fault() ==
      iterate::kit::platforms::
          DirectI2sStereoOutputFault::completionQueueOverflow);
}

/*
 * Four frames can be preloaded by one owner-task wake, but they do not begin
 * playback together: descriptor 0 starts at 0 ms and descriptors 1/2/3 at
 * 20/40/60 ms. Preserve each frame's receive metadata beside its exact EOF so
 * the upper policy can derive start age as
 * `max(0, eofAt - frameDuration - receivedAt)` rather than assigning one
 * misleading latency to the whole preload batch.
 */
void perDescriptorMetadataRetainsStaggeredPlaybackTime() {
  FakeDirectI2sBackend backend;
  Output output(backend);
  TEST_ASSERT(output.resetForPlayback() == ITERATE_KIT_OK);
  constexpr std::uint64_t receivedAtMs = 100U;
  constexpr std::uint64_t frameDurationUs = 20'000U;
  for (std::uint32_t index = 0U;
       index < descriptorCount;
       ++index) {
    const auto samples = frame(
        static_cast<std::int16_t>(index + 1U),
        static_cast<std::int16_t>(-(index + 1)));
    TEST_ASSERT(
        output.preloadMono(
            samples.data(),
            samples.size(),
            iterate::kit::platforms::
                DirectI2sFrameMetadata{
                  receivedAtMs, 7U, index + 100U}) ==
        ITERATE_KIT_OK);
  }
  TEST_ASSERT(output.start() == ITERATE_KIT_OK);

  for (std::uint32_t index = 0U;
       index < descriptorCount;
       ++index) {
    const auto eofAtUs =
        receivedAtMs * 1'000U +
        frameDurationUs * (index + 1U);
    backend.complete(
        FakeDirectI2sBackend::token(
            backend.generation, index),
        eofAtUs);
    (void)output.takeCompletionBatch();
    iterate::kit::platforms::
        DirectI2sDescriptorCompletion completion{};
    TEST_ASSERT(output.lastCompletion(0U, &completion));
    TEST_ASSERT(completion.eofAtUs == eofAtUs);
    TEST_ASSERT(
        completion.frame.receivedAtMs == receivedAtMs);
    TEST_ASSERT(completion.frame.generation == 7U);
    TEST_ASSERT(
        completion.frame.sequence == index + 100U);

    const auto playbackStartAtUs =
        completion.eofAtUs - frameDurationUs;
    const auto startAgeUs =
        playbackStartAtUs -
        completion.frame.receivedAtMs * 1'000U;
    TEST_ASSERT(
        startAgeUs ==
        static_cast<std::uint64_t>(index) *
            frameDurationUs);

    const auto replacement = frame(30, -30);
    TEST_ASSERT(
        output.writeMono(
            replacement.data(),
            replacement.size(),
            iterate::kit::platforms::
                DirectI2sFrameMetadata{
                  receivedAtMs + 80U,
                  7U,
                  index + 200U}) ==
        ITERATE_KIT_OK);
  }
}

/*
 * A destructive reset changes physical descriptor identities. A late callback
 * from the deleted channel must not be exposed as a completion for the new
 * generation, because doing so would update latency/lifecycle metrics with old
 * speech and hand an invalid pointer back to the writer.
 */
void staleGenerationEofCannotBecomeCurrentCompletion() {
  FakeDirectI2sBackend backend;
  Output output(backend);
  preloadAndStart(output, backend);
  const auto oldDescriptor =
      FakeDirectI2sBackend::token(backend.generation, 0U);
  TEST_ASSERT(output.resetForPlayback() == ITERATE_KIT_OK);
  for (std::int16_t value = 1; value <= 4; ++value) {
    const auto samples = frame(value, -value);
    TEST_ASSERT(
        output.preloadMono(
            samples.data(),
            samples.size(),
            iterate::kit::platforms::
                DirectI2sFrameMetadata{
                  200U, 9U,
                  static_cast<std::uint32_t>(value)}) ==
        ITERATE_KIT_OK);
  }
  TEST_ASSERT(output.start() == ITERATE_KIT_OK);

  backend.complete(oldDescriptor, 250'000U);
  const auto poll = output.pollCompletionBatch();
  TEST_ASSERT(poll.status == ITERATE_KIT_STATE_ERROR);
  TEST_ASSERT(
      poll.batch.newlyCompletedDescriptorCount == 0U);
  TEST_ASSERT(output.lastCompletionCount() == 0U);
  TEST_ASSERT(
      output.fault() ==
      iterate::kit::platforms::
          DirectI2sStereoOutputFault::descriptorIdentity);
}

/*
 * Reset is the reconnect/underrun safety barrier. A cursor rewind is
 * insufficient because old DMA content and queued EOFs could then cross into
 * a new voice generation. Require a new backend token generation, zero local
 * refill ownership, and four wholly new preloads before restart.
 */
void resetDestructivelyAbandonsOldDescriptors() {
  FakeDirectI2sBackend backend;
  Output output(backend);
  preloadAndStart(output, backend);
  const auto oldGeneration = backend.generation;
  backend.complete(
      FakeDirectI2sBackend::token(oldGeneration, 0U));
  (void)output.takeCompletionBatch();
  TEST_ASSERT(output.pendingRefillDescriptorCount() == 1U);

  TEST_ASSERT(output.resetForPlayback() == ITERATE_KIT_OK);
  TEST_ASSERT(backend.generation == oldGeneration + 1U);
  TEST_ASSERT(output.pendingRefillDescriptorCount() == 0U);
  TEST_ASSERT(output.preloadedDescriptorCount() == 0U);
  TEST_ASSERT(!backend.running);

  for (std::int16_t value = 20; value <= 23; ++value) {
    const auto samples = frame(value, -value);
    TEST_ASSERT(
        output.preloadMono(
            samples.data(), samples.size()) ==
        ITERATE_KIT_OK);
  }
  TEST_ASSERT(output.start() == ITERATE_KIT_OK);
  TEST_ASSERT(
      backend.preloadHistory[
          backend.preloadHistoryCount - 4U] ==
      FakeDirectI2sBackend::token(
          backend.generation, 0U));
}

/*
 * The wrapper intentionally pays for one 1,280-byte stereo expansion buffer
 * plus four bounded descriptor metadata/EOF observations. The current 64-bit
 * host layout is 1,696 bytes (ESP32 tokens are narrower); this small headroom
 * keeps ordinary ABI padding portable while making an accidental vector,
 * virtual base, or second PCM frame visible before it becomes device pressure.
 */
static_assert(std::is_trivially_destructible_v<Output>);
static_assert(sizeof(Output) <= 1'728U);

}  // namespace

int main() {
  RUN_TEST(descriptorIdentitySurvivesOrderedWraps);
  RUN_TEST(pendingDescriptorDeadlineDecaysWithoutNewEof);
  RUN_TEST(successfulRefillTimingIsForwardedFromTheExactWrite);
  RUN_TEST(startWaitsForFourExactPreloads);
  RUN_TEST(finitePrebufferCanBePaddedWithExactSilence);
  RUN_TEST(partialSilencePreloadIsNotAcceptedAsPadding);
  RUN_TEST(partialPreloadCannotBecomePlayableContent);
  RUN_TEST(nonblockingOutcomesNeverLoseACompletedDescriptor);
  RUN_TEST(partialNonblockingWritePoisonsTheGeneration);
  RUN_TEST(completionQueueOverflowIsVisibleAndFatalToGeneration);
  RUN_TEST(directMemcpyWithoutPrivateQueueDrainFailsOnFourthEof);
  RUN_TEST(perDescriptorMetadataRetainsStaggeredPlaybackTime);
  RUN_TEST(staleGenerationEofCannotBecomeCurrentCompletion);
  RUN_TEST(resetDestructivelyAbandonsOldDescriptors);
  return 0;
}
