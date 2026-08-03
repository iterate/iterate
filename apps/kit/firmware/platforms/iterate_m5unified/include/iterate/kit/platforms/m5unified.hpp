#ifndef ITERATE_KIT_PLATFORMS_M5UNIFIED_HPP
#define ITERATE_KIT_PLATFORMS_M5UNIFIED_HPP

#include "iterate/kit/audio.h"
#include "iterate/kit/avatar/face_avatar_registry.h"
#include "iterate/kit/capabilities/avatar.h"
#include "iterate/kit/conversation_lights.h"
#include "iterate/kit/capabilities/metrics.h"
#include "iterate/kit/capabilities/screen.h"
#include "iterate/kit/capabilities/screen_capture.h"
#include "iterate/kit/cpu_usage.h"
#include "iterate/kit/platforms/bounded_capture.hpp"
#include "iterate/kit/platforms/realtime_playback.hpp"

#include <cstddef>
#include <cstdint>

namespace iterate::kit::platforms {

class M5StickS3DirectAudioOwner;

/**
 * Small product-facing state vocabulary for the Stick's built-in display.
 *
 * These are deliberately user states, not a dump of ESP-IDF transport enums.
 * The target reconciles control, PCM, capture, and speaker state into one of
 * these values; the board adapter only renders it. That separation prevents a
 * screen string from becoming a second call state machine while still keeping
 * button-specific copy out of the portable device core.
 */
enum class M5StickS3CallUiState : std::uint8_t {
  booting = 0U,
  controlConnecting,
  ready,
  callConnecting,
  callReady,
  listening,
  waitingForReply,
  speaking,
  endingCall,
  callFailed,
};

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
  /**
   * Consumes one BtnB press used as a call-lifecycle toggle.
   *
   * A release is deliberately not exposed: mapping both edges to a toggle
   * would open and immediately close every call, while retaining full level
   * state would add no information to this one-shot control.
   */
  bool takeButtonBPress();

  /* Lightweight driver views borrow this object for its entire lifetime. */
  iterate_kit_screen_driver screenDriver();
  iterate_kit_avatar_driver avatarDriver();
  iterate_kit_screen_capture_driver screenCaptureDriver();
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
  RealtimePlaybackState playbackState() const;
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
  /**
   * Repaints only on a semantic transition (or a background-colour change).
   * Calling this from every application-owner pass is therefore cheap and
   * cannot turn the 10 ms control cadence into continuous display/SPI work.
   */
  void showCallUi(
      M5StickS3CallUiState state,
      const iterate_kit_conversation_visual_state &visualState);

 private:
  using Capture = BoundedCapture<captureSampleCount, captureSampleRate>;
  /*
   * M5StickS3 microphone startup has a transient settling frame. Dropping one
   * known 20 ms frame is cheaper and more deterministic than filtering every
   * sample or sending the transient to provider VAD as apparent speech.
   */
  static constexpr std::uint8_t microphoneStartupFramesToDiscard = 1U;
  static constexpr std::int64_t avatarRenderIntervalMicroseconds = 66'000;

  static iterate_kit_status renderPngUrl(
      void *context, const char *url, std::size_t urlLength);
  static iterate_kit_status changeSpriteSet(
      void *context, const char *slug, std::size_t slugLength);
  static iterate_kit_status captureScreen(
      void *context, iterate_kit_captured_screen *capture);
  static void releaseCapturedScreen(void *context);
  static iterate_kit_status sampleMetrics(
      void *context, iterate_kit_metrics_sample *sample);
  static iterate_kit_status startCapture(void *context);
  static iterate_kit_status stopCapture(void *context);
  static iterate_kit_status stopPlayback(void *context);
  static iterate_kit_status flushPlayback(void *context);
  static iterate_kit_status preparePlayback(void *context);
  static iterate_kit_status pollCapture(
      void *context,
      iterate_kit_audio_capture_submit_fn submit,
      void *submitContext);
  void renderCallUi(bool force);
  void renderStatusPanel();
  bool renderAvatar(std::int64_t nowMicroseconds, bool force);

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
  bool buttonBPressPending_ = false;
  bool microphoneActive_ = false;
  void *capturedScreenPng_ = nullptr;
  /*
   * One PSRAM framebuffer is the entire display-side frame storage. It is not
   * DMA/audio memory and no second visual frame or render queue exists. A
   * later pose simply replaces these pixels after the current synchronous
   * display upload, so visual load can lose detail but can never accumulate.
   */
  std::uint16_t *avatarFramebuffer_ = nullptr;
  face_avatar_registry_t avatarRegistry_{};
  M5StickS3CallUiState callUiState_ =
      M5StickS3CallUiState::booting;
  iterate_kit_conversation_visual_state conversationVisualState_{};
  std::uint32_t renderedAvatarPublication_ = 0U;
  std::int64_t nextAvatarRenderMicroseconds_ = 0;
  std::uint32_t avatarRenderFailures_ = 0U;
  bool callUiDrawn_ = false;
  bool conversationVisualStateDrawn_ = false;
  bool avatarNeedsRender_ = true;
};

}  // namespace iterate::kit::platforms

#endif
