#ifndef ITERATE_KIT_PLATFORMS_M5STICKS3_DIRECT_AUDIO_HPP
#define ITERATE_KIT_PLATFORMS_M5STICKS3_DIRECT_AUDIO_HPP

#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/avatar/face_animator.h"
#include "iterate/kit/avatar/face_pose.h"
#include "iterate/kit/platforms/bounded_event_counter.hpp"
#include "iterate/kit/platforms/direct_i2s_stereo_output.hpp"
#include "iterate/kit/platforms/esp_idf_direct_i2s_backend.hpp"
#include "iterate/kit/platforms/m5sticks3_realtime_audio_policy.hpp"
#include "iterate/kit/platforms/realtime_owner_control.hpp"
#include "iterate/kit/platforms/realtime_playback.hpp"
#include "iterate/kit/platforms/release_owned_handle.hpp"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

#include "driver/i2s_std.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

namespace iterate::kit::platforms {

/**
 * Thin, target-only implementation of the backend's I2S operations.
 *
 * The class owns exactly one ESP-IDF TX channel. It intentionally exposes no
 * buffering controls: descriptor count/shape are part of the M5StickS3 audio
 * contract below, and the portable backend owns descriptor identity/timing.
 */
class M5StickS3DirectI2sOps {
 public:
  static constexpr std::size_t descriptorCount =
      M5StickS3RealtimeAudioPolicy::descriptorCount;
  static constexpr std::size_t monoSampleCount = 320U;
  static constexpr std::size_t stereoFrameBytes =
      monoSampleCount * 2U * sizeof(std::int16_t);
  static constexpr std::uint32_t frameDurationUs = 20'000U;

  void setOwnerTask(TaskHandle_t ownerTask);

  iterate_kit_status createAndConfigure(
      void *context,
      EspIdfDirectI2sSentCallback sentCallback,
      EspIdfDirectI2sOverflowCallback overflowCallback);
  iterate_kit_status release();
  EspIdfDirectI2sIoResult preload(
      const void *stereo,
      std::size_t bytes);
  iterate_kit_status enable();
  EspIdfDirectI2sIoResult write(
      const void *stereo,
      std::size_t bytes,
      DirectI2sDescriptorToken descriptor);
  std::uint64_t monotonicMicroseconds() const;
  bool IRAM_ATTR notifyOwnerFromIsr();

 private:
  static bool IRAM_ATTR onSent(
      i2s_chan_handle_t,
      i2s_event_data_t *event,
      void *context);
  static bool IRAM_ATTR onSendQueueOverflow(
      i2s_chan_handle_t,
      i2s_event_data_t *,
      void *context);
  iterate_kit_status deleteChannelAndClearCallbacks();

  i2s_chan_handle_t channel_ = nullptr;
  TaskHandle_t ownerTask_ = nullptr;
  void *callbackContext_ = nullptr;
  EspIdfDirectI2sSentCallback sentCallback_ = nullptr;
  EspIdfDirectI2sOverflowCallback overflowCallback_ = nullptr;
  bool enabled_ = false;
};

/**
 * M5StickS3 codec and power-amplifier controls.
 *
 * M5.begin() configures M5PM1 GPIO3 as a push-pull output and leaves it low.
 * This class only changes that output latch and writes the documented ES8311
 * DAC register set; it never starts M5Unified's separate speaker task.
 */
class M5StickS3AudioBoardOps {
 public:
  iterate_kit_status setAmplifierEnabled(bool enabled);
  iterate_kit_status configureCodec();
};

using M5StickS3DirectI2sBackend =
    EspIdfDirectI2sBackend<
        M5StickS3DirectI2sOps::descriptorCount,
        M5StickS3DirectI2sOps::stereoFrameBytes,
        M5StickS3DirectI2sOps::frameDurationUs,
        M5StickS3DirectI2sOps,
        M5StickS3AudioBoardOps>;

using M5StickS3DirectI2sOutput =
    DirectI2sStereoOutput<
        M5StickS3DirectI2sOps::monoSampleCount,
        M5StickS3DirectI2sOps::descriptorCount,
        M5StickS3DirectI2sBackend>;

/**
 * Latest semantic face pose proven by an exact physical DMA completion.
 *
 * The publication sequence is a diagnostic identity, not a render queue. A
 * low-priority display owner may skip any number of poses and draw only the
 * newest coherent snapshot; audio never waits for it.
 */
struct M5StickS3AvatarSnapshot {
  face_pose_t pose{};
  std::uint32_t publicationSequence = 0U;
};

/**
 * Lossy visual sidecar around the direct-I2S output contract.
 *
 * Each successfully submitted content frame is analyzed immediately into a
 * compact pose and stored beside its `{generation, sequence}` identity. The
 * pose is published only when the wrapped driver reports that same frame's DMA
 * descriptor complete. This prevents network/prebuffer lead from making the
 * mouth move ahead of the audible speaker.
 *
 * Only one pose per physical descriptor can exist. There is no PCM copy or
 * visual FIFO. Visual
 * bookkeeping failure increments a diagnostic counter and drops animation;
 * it must never change an audio return value or deadline.
 */
class M5StickS3AvatarOutput {
 public:
  static constexpr std::size_t descriptorCount =
      M5StickS3DirectI2sOps::descriptorCount;

  explicit M5StickS3AvatarOutput(
      M5StickS3DirectI2sOutput &output);

  bool initialise();
  iterate_kit_status resetForPlayback();
  iterate_kit_status preloadMono(
      const std::int16_t *samples,
      std::size_t sampleCount);
  iterate_kit_status preloadMono(
      const std::int16_t *samples,
      std::size_t sampleCount,
      DirectI2sFrameMetadata metadata);
  iterate_kit_status preloadSilence();
  iterate_kit_status start();
  DirectI2sCompletionPollResult pollCompletionBatch();
  iterate_kit_status writeMono(
      const std::int16_t *samples,
      std::size_t sampleCount);
  iterate_kit_status writeMono(
      const std::int16_t *samples,
      std::size_t sampleCount,
      DirectI2sFrameMetadata metadata);
  iterate_kit_status writeSilence();
  iterate_kit_status writeRecoverySilence();
  std::uint32_t takeQueueOverflows();
  iterate_kit_status stopAndRelease();
  bool lastPlaybackCompletion(
      std::size_t index,
      RealtimePlaybackDescriptorCompletion *completion) const;
  RealtimePlaybackSuccessfulRefillTiming
  lastSuccessfulRefillTiming() const;

  bool snapshot(M5StickS3AvatarSnapshot *snapshot) const;
  std::uint32_t droppedPoseCount() const;
  std::uint32_t completionWithoutPoseCount() const;

 private:
  struct PendingPose {
    DirectI2sFrameMetadata metadata{};
    face_pose_t pose{};
    bool occupied = false;
  };

  void clearPendingPoses();
  void noteSubmittedPose(
      const std::int16_t *samples,
      std::size_t sampleCount,
      DirectI2sFrameMetadata metadata);
  void publishCompletedPoses();
  void publishPose(const face_pose_t &pose);
  void publishQuietPose();
  static bool metadataEqual(
      DirectI2sFrameMetadata left,
      DirectI2sFrameMetadata right);
  static std::uint32_t packBytes(
      std::uint8_t byte0,
      std::uint8_t byte1,
      std::uint8_t byte2,
      std::uint8_t byte3);

  M5StickS3DirectI2sOutput &output_;
  face_animator_t animator_{};
  std::array<PendingPose, descriptorCount> pendingPoses_{};
  std::atomic<std::uint32_t> posePublication_{0U};
  std::atomic<std::uint32_t> poseWord0_{0U};
  std::atomic<std::uint32_t> poseWord1_{0U};
  std::atomic<std::uint32_t> poseWord2_{0U};
  std::atomic<std::uint32_t> poseWord3_{0U};
  std::atomic<std::uint32_t> poseFrameIndex_{0U};
  std::atomic<std::uint32_t> posePlayoutSamples_{0U};
  std::atomic<std::uint32_t> droppedPoses_{0U};
  std::atomic<std::uint32_t> completionsWithoutPose_{0U};
  bool initialised_ = false;
};

using M5StickS3RealtimePlayback =
    RealtimePlayback<
        M5StickS3DirectI2sOps::monoSampleCount,
        16'000U,
        M5StickS3DirectI2sOps::descriptorCount,
        M5StickS3RealtimeAudioPolicy::maximumFrameAgeMs,
        M5StickS3RealtimeAudioPolicy::partialPrebufferTimeoutMs,
        M5StickS3RealtimeAudioPolicy::minimumRefillLeadUs>;

/**
 * Sole task owner of the Stick's speaker policy and direct-I2S descriptor set.
 *
 * Network receive and the application task may only wake or submit one bounded
 * lifecycle command. Every policy/backend call—including metrics snapshots—is
 * executed by the priority-19 Core-1 owner, so callback metadata, descriptor
 * identity, and the lane's consumer cursor never need locks.
 *
 * This object contains no PCM FIFO. Its only application PCM storage is the
 * output adapter's one mono-to-stereo scratch frame. The bounded physical DMA
 * cycle is allocated by ESP-IDF when a channel is created and is explicitly
 * reported as a separate runtime-driver budget.
 */
class M5StickS3DirectAudioOwner {
 public:
  static constexpr std::size_t audioTaskStackBytes = 8'192U;
  static_assert(
      audioTaskStackBytes % sizeof(StackType_t) == 0U);
  static constexpr std::size_t audioTaskStackDepth =
      audioTaskStackBytes / sizeof(StackType_t);
  static constexpr std::size_t dmaAudioBytes =
      M5StickS3DirectI2sOps::descriptorCount *
      M5StickS3DirectI2sOps::stereoFrameBytes;
  static constexpr std::size_t stereoScratchBytes =
      M5StickS3DirectI2sOps::stereoFrameBytes;

  iterate_kit_status begin(iterate_kit_pcm_lane *lane);
  void notifyDownlinkReady();

  RealtimePlaybackPumpResult takePumpResult();
  /** Lock-free state projection for low-cost product UI reconciliation. */
  RealtimePlaybackState playbackState() const;
  RealtimePlaybackMetrics playbackMetrics();
  bool avatarSnapshot(M5StickS3AvatarSnapshot *snapshot) const;
  std::uint32_t avatarDroppedPoseCount() const;
  std::uint32_t avatarCompletionWithoutPoseCount() const;
  std::uint32_t stackHighWaterBytes() const;
  std::uint32_t
  generationFenceAcknowledgementTimeouts() const;
  std::uint32_t
  lifecycleAcknowledgementTimeouts() const;

  iterate_kit_status flushGeneration(
      std::uint32_t generation,
      bool connected);
  iterate_kit_status suspendForCapture();
  iterate_kit_status resumeAfterCapture();

 private:
  enum class GenerationFenceCommand : std::uint8_t {
    flushGeneration = 0U,
  };

  enum class LifecycleCommand : std::uint8_t {
    begin = 0U,
    suspend,
    resume,
    snapshotMetrics,
  };

  static constexpr std::uint32_t frameSubmittedEdge =
      1U << 0U;
  static constexpr std::uint32_t playbackStartedEdge =
      1U << 1U;
  static constexpr UBaseType_t realtimeTaskPriority = 19U;
  static constexpr BaseType_t realtimeTaskCore = 1;
  static constexpr std::uint32_t commandAcknowledgementMs =
      1'000U;
  static constexpr std::uint32_t partialPrebufferTimeoutMs =
      200U;
  using GenerationFenceMailbox =
      SingleOwnerCommandMailbox<
          GenerationFenceCommand,
          commandAcknowledgementMs>;
  using LifecycleMailbox =
      SingleOwnerCommandMailbox<
          LifecycleCommand,
          commandAcknowledgementMs>;
  using PrebufferDeadline =
      PartialPrebufferWakeDeadline<
          partialPrebufferTimeoutMs>;

  static void taskEntry(void *context);
  void taskLoop();
  iterate_kit_status executeGenerationFenceCommand(
      GenerationFenceCommand command,
      std::uint32_t generation,
      bool connected);
  iterate_kit_status executeLifecycleCommand(
      LifecycleCommand command);
  iterate_kit_status runBoundedCommand(
      LifecycleCommand command);
  iterate_kit_status stopAndDiscard();
  void publishPumpResult(
      RealtimePlaybackPumpResult result);
  void publishPlaybackState();
  void sampleStackHighWater();

  M5StickS3DirectI2sOps i2s_{};
  M5StickS3AudioBoardOps board_{};
  M5StickS3DirectI2sBackend backend_{i2s_, board_};
  M5StickS3DirectI2sOutput directOutput_{backend_};
  M5StickS3AvatarOutput output_{directOutput_};
  M5StickS3RealtimePlayback playback_{};
  iterate_kit_pcm_lane *lane_ = nullptr;

  /*
   * Static task/semaphore storage makes the scheduling cost part of the
   * compiled RAM report. Dynamic creation would make low-memory playback
   * failures depend on allocator fragmentation and hide this fixed budget.
   */
  std::array<StackType_t, audioTaskStackDepth>
      taskStack_{};
  StaticTask_t taskStorage_{};
  TaskHandle_t task_ = nullptr;
  StaticSemaphore_t commandCompleteStorage_{};
  SemaphoreHandle_t commandComplete_ = nullptr;

  /*
   * There is one application-side producer, but two semantically independent
   * rendezvous lanes. A completed asynchronous generation fence may sit until
   * the transport polls it; a synchronous metrics/lifecycle request must never
   * overwrite that result and make the transport repeat physical teardown.
   * Different command enum types and different one-slot storage make that
   * cross-lane publication impossible while keeping each lane constant-space.
   *
   * The semaphore acknowledges only synchronous lifecycle work. Generation
   * polling remains nonblocking and receives its exact result from its own
   * mailbox; neither mechanism is an audio queue or per-frame counter.
   */
  GenerationFenceMailbox generationFenceMailbox_{};
  LifecycleMailbox lifecycleMailbox_{};
  PrebufferDeadline prebufferDeadline_{};
  BoundedEventCounter
      generationFenceAcknowledgementTimeouts_{};
  BoundedEventCounter
      lifecycleAcknowledgementTimeouts_{};
  /*
   * Physical PTT stops I2S before its event can cross Cap'n Web and cancel the
   * provider. The owner discards the few obsolete frames which can arrive in
   * that causal gap while capture owns the pins. They are expected generation
   * loss—not transport faults—but must still join exact played-or-flushed
   * accounting. Owner-local storage avoids an atomic on the 20 ms path.
   */
  BoundedEventCounter suspendedFramesFlushed_{};

  std::atomic<std::int32_t> publishedStatus_{
      ITERATE_KIT_UNAVAILABLE};
  std::atomic<std::uint32_t> publishedEdges_{0U};
  std::atomic<std::uint8_t> publishedPlaybackState_{
      static_cast<std::uint8_t>(RealtimePlaybackState::stopped)};
  std::atomic<std::uint32_t> stackHighWaterBytes_{0U};
  RealtimePlaybackMetrics metricsSnapshot_{};
  std::uint32_t currentGeneration_ = 0U;
  bool suspended_ = false;
};

}  // namespace iterate::kit::platforms

#endif
