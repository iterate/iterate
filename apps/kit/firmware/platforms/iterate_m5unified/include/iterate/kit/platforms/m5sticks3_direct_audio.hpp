#ifndef ITERATE_KIT_PLATFORMS_M5STICKS3_DIRECT_AUDIO_HPP
#define ITERATE_KIT_PLATFORMS_M5STICKS3_DIRECT_AUDIO_HPP

#include "iterate/kit/pcm_lane.h"
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
  static constexpr std::size_t descriptorCount = 4U;
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
 * output adapter's one mono-to-stereo scratch frame. The four physical DMA
 * frames are allocated by ESP-IDF when a channel is created and are explicitly
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
  RealtimePlaybackMetrics playbackMetrics();
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
  void sampleStackHighWater();

  M5StickS3DirectI2sOps i2s_{};
  M5StickS3AudioBoardOps board_{};
  M5StickS3DirectI2sBackend backend_{i2s_, board_};
  M5StickS3DirectI2sOutput output_{backend_};
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
  std::atomic<std::uint32_t> stackHighWaterBytes_{0U};
  RealtimePlaybackMetrics metricsSnapshot_{};
  std::uint32_t currentGeneration_ = 0U;
  bool suspended_ = false;
};

}  // namespace iterate::kit::platforms

#endif
