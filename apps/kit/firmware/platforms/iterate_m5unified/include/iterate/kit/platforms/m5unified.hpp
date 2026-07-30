#ifndef ITERATE_KIT_PLATFORMS_M5UNIFIED_HPP
#define ITERATE_KIT_PLATFORMS_M5UNIFIED_HPP

#include "iterate/kit/audio.h"
#include "iterate/kit/capabilities/metrics.h"
#include "iterate/kit/capabilities/screen.h"
#include "iterate/kit/cpu_usage.h"
#include "iterate/kit/platforms/bounded_capture.hpp"
#include "iterate/kit/platforms/realtime_playback.hpp"

#include <cstddef>
#include <cstdint>

namespace iterate::kit::platforms {

class M5StickS3DirectAudioOwner;

/**
 * M5StickS3 hardware adapter with an explicitly half-duplex audio policy.
 *
 * The first device proof has no validated acoustic echo cancellation. Playing
 * the assistant while the nearby microphone is live would feed output straight
 * back into VAD/voice input and make interruption behavior nondeterministic.
 * Push-to-talk therefore owns the microphone while held; inbound playback is
 * flushed/discarded at that boundary and resumes only after capture stops. A
 * future full-duplex/AEC-capable board should implement the same portable
 * drivers with a different hardware policy rather than adding device branches
 * to the core audio state machine.
 *
 * Capture uses the device/provider-friendly native 16 kHz signed PCM format:
 * 320 samples are exactly 20 ms. Keeping that format end to end avoids a
 * resampler, its CPU cost, and an additional sample queue. Two capture buffers
 * keep M5Unified's recorder slots armed. Playback is delegated to the direct
 * I2S owner: its one expansion scratch frame and IDF DMA storage are reported
 * separately rather than hidden inside this board/UI adapter.
 *
 * The application task owns M5 update/button/display/capture. A dedicated
 * priority-19 Core-1 task owns every playback policy and I2S call; this class
 * crosses that boundary only through bounded notifications and synchronous
 * lifecycle fences. Neither layer allocates application audio storage after
 * construction.
 */
class M5UnifiedHalfDuplex {
 public:
  static constexpr std::uint32_t captureSampleRate = 16'000U;
  static constexpr std::size_t captureSampleCount = 320U;
  static constexpr std::size_t captureFrameCount =
      BoundedCapture<
          captureSampleCount,
          captureSampleRate>::frameBufferCount;
  static constexpr std::size_t captureFrameStorageBytes =
      captureFrameCount *
      captureSampleCount * sizeof(std::int16_t);

  explicit M5UnifiedHalfDuplex(
      M5StickS3DirectAudioOwner &audioOwner);

  /** Boots only required peripherals and verifies the expected board ID. */
  bool begin();
  /** Samples M5Unified input; call frequently from the sole owner task. */
  void update();
  /**
   * Consumes one coalesced BtnA level change.
   *
   * The owner polls at a much finer cadence than human button motion. If
   * several electrical/UI edges arrive before consumption, only the latest
   * stable level matters for entering/leaving push-to-talk; this is not an
   * archival button-event queue.
   */
  bool takeButtonAChange(bool *pressed);

  /* Lightweight driver views borrow this object for its entire lifetime. */
  iterate_kit_screen_driver screenDriver();
  iterate_kit_metrics_driver metricsDriver();
  iterate_kit_audio_hardware audioHardware();
  iterate_kit_audio_capture_driver audioCaptureDriver();
  iterate_kit_status bindPcmLane(iterate_kit_pcm_lane *lane);
  /**
   * Consumes coalesced status/lifecycle edges published by the audio owner.
   * It does not touch the lane, policy, or speaker hardware.
   */
  RealtimePlaybackPumpResult pollPlayback();
  RealtimePlaybackMetrics playbackMetrics();
  /** Constant-space wake hint used by the PCM network callback. */
  void notifyPlaybackReady();
  /**
   * Polls the reconnect fence for the PCM transport generation gate.
   *
   * The first call schedules physical teardown on the audio owner and returns
   * UNAVAILABLE. A later byte-identical call returns its completion; this keeps
   * the network/application task non-blocking while receive admission remains
   * closed. Unlike interruption, a successful connected fence restores speaker
   * readiness because the socket may immediately deliver its first frame.
   */
  iterate_kit_status flushPlaybackGeneration(
      std::uint32_t generation,
      bool connected);

  void showStatus(
      const char *status,
      std::uint64_t capturedFrames,
      std::uint64_t droppedFrames);

 private:
  using Capture = BoundedCapture<captureSampleCount, captureSampleRate>;
  /*
   * M5StickS3 microphone startup has a transient settling frame. Dropping one
   * known 20 ms frame is cheaper and more deterministic than filtering every
   * sample or sending the transient to provider VAD as apparent speech.
   */
  static constexpr std::uint8_t microphoneStartupFramesToDiscard = 1U;

  static iterate_kit_status renderPngUrl(
      void *context, const char *url, std::size_t urlLength);
  static iterate_kit_status sampleMetrics(
      void *context, iterate_kit_metrics_sample *sample);
  static iterate_kit_status startCapture(void *context);
  static iterate_kit_status stopCapture(void *context);
  static iterate_kit_status stopPlayback(void *context);
  static iterate_kit_status flushPlayback(void *context);
  static iterate_kit_status pollCapture(
      void *context,
      iterate_kit_audio_capture_submit_fn submit,
      void *submitContext);

  /*
   * Capture buffers remain inline because M5Unified retains their pointers.
   * Speaker scratch/DMA/task storage belongs to audioOwner_, whose separate
   * report prevents application buffers from being conflated with IDF DMA.
   */
  Capture capture_;
  M5StickS3DirectAudioOwner &audioOwner_;
  iterate_kit_pcm_lane *pcmLane_ = nullptr;
  iterate_kit_cpu_usage_meter cpuUsage_{};
  std::int64_t startedMicroseconds_ = 0;
  bool buttonPressed_ = false;
  bool buttonChangePending_ = false;
  bool microphoneActive_ = false;
};

}  // namespace iterate::kit::platforms

#endif
