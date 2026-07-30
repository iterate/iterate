#include "iterate/kit/platforms/m5unified.hpp"
#include "iterate/kit/platforms/m5sticks3_direct_audio.hpp"

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#pragma GCC diagnostic ignored "-Wvla"
#include <M5Unified.h>
#pragma GCC diagnostic pop

#include <algorithm>
#include <cstring>

#include "esp_heap_caps.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/task.h"

namespace iterate::kit::platforms {

/*
 * FreeRTOS exposes idle runtime per core, while product telemetry wants one
 * device-wide CPU fraction. Summing is valid because the portable meter is
 * initialized with the same core count. This remains scheduler runtime
 * evidence—not a cycle attribution for a particular audio stage.
 */
static std::uint64_t aggregateIdleTime() {
  std::uint64_t aggregate = 0U;
  for (BaseType_t core = 0;
       core < CONFIG_FREERTOS_NUMBER_OF_CORES;
       ++core) {
    aggregate += ulTaskGetIdleRunTimeCounterForCore(core);
  }
  return aggregate;
}

M5UnifiedHalfDuplex::M5UnifiedHalfDuplex(
    M5StickS3DirectAudioOwner &audioOwner)
    : audioOwner_(audioOwner) {}

bool M5UnifiedHalfDuplex::begin() {
  auto config = M5.config();
  /*
   * Enable only peripherals required by this target. This reduces background
   * bus work and makes power/RAM behavior easier to attribute during the audio
   * proof; optional IMU/RTC/LED behavior belongs in device-specific capability
   * adapters, not an always-on side effect of M5Unified startup.
   */
  config.clear_display = true;
  config.output_power = false;
  config.internal_imu = false;
  config.internal_rtc = false;
  config.internal_mic = true;
  config.internal_spk = true;
  config.external_imu = false;
  config.external_rtc = false;
  config.led_brightness = 0;
  M5.begin(config);
  if (M5.getBoard() != m5::board_t::board_M5StickS3) {
    /*
     * M5Unified supports many boards with different pin/audio topology.
     * Failing closed prevents a seemingly successful flash from driving the
     * wrong speaker/microphone pins and producing misleading timing results.
     */
    return false;
  }

  M5.Mic.end();
  M5.Speaker.end();
  /*
   * M5.begin() is retained for board detection, display/input setup, and its
   * documented PMIC GPIO mux. End both generic audio objects immediately:
   * playback below creates a direct ESP-IDF channel and must never coexist with
   * M5Unified's mixer task or retained playRaw() buffers.
   */
  M5.Display.setRotation(1);
  M5.Display.setBrightness(96);
  M5.Display.fillScreen(TFT_BLACK);
  M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  M5.Display.setTextSize(1);
  M5.Display.setCursor(8, 8);
  M5.Display.println("Iterate Kit / M5StickS3");
  M5.Display.println("Hold BtnA to talk");
  startedMicroseconds_ = esp_timer_get_time();
  if (iterate_kit_cpu_usage_meter_init(
          &cpuUsage_, CONFIG_FREERTOS_NUMBER_OF_CORES) !=
      ITERATE_KIT_OK) {
    return false;
  }
  std::int64_t ignoredCpuPermille = -1;
  /*
   * Prime the delta-based CPU meter now. Reporting the first lifetime-total
   * sample as a one-second interval would create a meaningless boot spike.
   */
  return iterate_kit_cpu_usage_meter_sample(
             &cpuUsage_,
             static_cast<std::uint64_t>(startedMicroseconds_),
             aggregateIdleTime(),
             &ignoredCpuPermille) == ITERATE_KIT_OK;
}

void M5UnifiedHalfDuplex::update() {
  M5.update();
  /*
   * Store stable level plus one pending bit instead of queueing edges. Human
   * push-to-talk is polled every main-loop pass, and the desired invariant is
   * eventual agreement with the physical button without allocating or letting
   * bounce build an event backlog.
   */
  if (M5.BtnA.wasPressed()) {
    buttonPressed_ = true;
    buttonChangePending_ = true;
  }
  if (M5.BtnA.wasReleased()) {
    buttonPressed_ = false;
    buttonChangePending_ = true;
  }
}

bool M5UnifiedHalfDuplex::takeButtonAChange(bool *pressed) {
  if (pressed == nullptr || !buttonChangePending_) return false;
  *pressed = buttonPressed_;
  buttonChangePending_ = false;
  return true;
}

iterate_kit_screen_driver M5UnifiedHalfDuplex::screenDriver() {
  return {this, renderPngUrl};
}

iterate_kit_metrics_driver M5UnifiedHalfDuplex::metricsDriver() {
  return {this, sampleMetrics};
}

iterate_kit_audio_hardware M5UnifiedHalfDuplex::audioHardware() {
  return {
    this,
    startCapture,
    stopCapture,
    stopPlayback,
    flushPlayback,
  };
}

iterate_kit_audio_capture_driver
M5UnifiedHalfDuplex::audioCaptureDriver() {
  return {
    this,
    pollCapture,
  };
}

iterate_kit_status M5UnifiedHalfDuplex::bindPcmLane(
    iterate_kit_pcm_lane *lane) {
  if (lane == nullptr || !lane->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  pcmLane_ = lane;
  /*
   * The lane is borrowed, not owned, and must outlive this adapter. Binding is
   * explicit because playback/capture storage belongs to different reusable
   * layers; constructing hidden global links would make host tests and a second
   * device target difficult to isolate.
   */
  return audioOwner_.begin(lane);
}

RealtimePlaybackPumpResult
M5UnifiedHalfDuplex::pollPlayback() {
  if (pcmLane_ == nullptr) {
    return {
      ITERATE_KIT_STATE_ERROR, false, false};
  }
  return audioOwner_.takePumpResult();
}

RealtimePlaybackMetrics
M5UnifiedHalfDuplex::playbackMetrics() {
  return audioOwner_.playbackMetrics();
}

void M5UnifiedHalfDuplex::notifyPlaybackReady() {
  audioOwner_.notifyDownlinkReady();
}

iterate_kit_status
M5UnifiedHalfDuplex::flushPlaybackGeneration(
    std::uint32_t generation,
    bool connected) {
  return audioOwner_.flushGeneration(
      generation, connected);
}

void M5UnifiedHalfDuplex::showStatus(
    const char *status,
    std::uint64_t capturedFrames,
    std::uint64_t droppedFrames) {
  M5.Display.fillRect(
      0,
      38,
      M5.Display.width(),
      M5.Display.height() - 38,
      TFT_BLACK);
  /*
   * This synchronous display path is only for coarse status/bring-up and makes
   * no realtime guarantee. It must not be called from capture, socket, or
   * speaker callbacks. A production renderer must pass through the display
   * refresh gate so SPI work is deferred around audio; do not grow this helper
   * into an image decoder.
   */
  M5.Display.setCursor(8, 42);
  M5.Display.printf("%s\n", status == nullptr ? "" : status);
  M5.Display.printf(
      "PCM sent: %llu\n",
      static_cast<unsigned long long>(capturedFrames));
  M5.Display.printf(
      "Dropped:  %llu\n",
      static_cast<unsigned long long>(droppedFrames));
  M5.Display.printf(
      "Heap: %lu KB\n",
      static_cast<unsigned long>(esp_get_free_heap_size() / 1024U));
}

iterate_kit_status M5UnifiedHalfDuplex::renderPngUrl(
    void *context, const char *url, std::size_t urlLength) {
  auto &platform = *static_cast<M5UnifiedHalfDuplex *>(context);
  if (url == nullptr ||
      urlLength < sizeof("https://") - 1U ||
      std::memcmp(url, "https://", sizeof("https://") - 1U) != 0) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * Keep the capability shape now but fail explicitly until a bounded HTTPS
   * fetch/decoder exists. Accepting plain HTTP would expose project-rendered
   * content to network substitution; pretending success would make remote
   * callers believe the image reached the screen.
   */
  platform.showStatus("PNG fetch not connected", 0U, 0U);
  return ITERATE_KIT_UNAVAILABLE;
}

iterate_kit_status M5UnifiedHalfDuplex::sampleMetrics(
    void *context, iterate_kit_metrics_sample *sample) {
  auto &platform = *static_cast<M5UnifiedHalfDuplex *>(context);
  constexpr std::uint32_t internalHeapCapabilities =
      MALLOC_CAP_8BIT | MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL;
  const auto nowMicroseconds = esp_timer_get_time();
  std::int64_t cpuPermille = -1;
  if (sample == nullptr) return ITERATE_KIT_INVALID_ARGUMENT;
  const auto cpuStatus = iterate_kit_cpu_usage_meter_sample(
      &platform.cpuUsage_,
      static_cast<std::uint64_t>(nowMicroseconds),
      aggregateIdleTime(),
      &cpuPermille);
  if (cpuStatus != ITERATE_KIT_OK) return cpuStatus;
  *sample = {};
  sample->uptime_ms =
      (nowMicroseconds - platform.startedMicroseconds_) / 1000;
  sample->free_heap_bytes = esp_get_free_heap_size();
  sample->minimum_free_heap_bytes =
      esp_get_minimum_free_heap_size();
  sample->free_internal_heap_bytes =
      esp_get_free_internal_heap_size();
  sample->minimum_free_internal_heap_bytes =
      heap_caps_get_minimum_free_size(internalHeapCapabilities);
  /*
   * Internal DMA-capable heap is the scarce memory relevant to audio drivers;
   * total heap can remain healthy while DMA allocation is near failure. PSRAM
   * is reported separately because it cannot be treated as interchangeable
   * realtime/DMA storage.
   */
  sample->free_psram_bytes =
      heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  const auto applicationStackHighWaterBytes =
      uxTaskGetStackHighWaterMark(nullptr) *
      sizeof(StackType_t);
  const auto audioStackHighWaterBytes =
      platform.audioOwner_.stackHighWaterBytes();
  /*
   * The public schema currently has one stack field. Report the smaller live
   * margin across application and realtime-audio owners, since that is the
   * actionable exhaustion bound; the compiled resource profile separately
   * preserves the audio task's exact 8 KiB allocation.
   */
  sample->task_stack_high_water_bytes =
      audioStackHighWaterBytes == 0U
      ? applicationStackHighWaterBytes
      : std::min(
          static_cast<std::uint32_t>(
              applicationStackHighWaterBytes),
          audioStackHighWaterBytes);
  sample->cpu_permille = cpuPermille;
  return ITERATE_KIT_OK;
}

iterate_kit_status M5UnifiedHalfDuplex::startCapture(void *context) {
  auto &platform = *static_cast<M5UnifiedHalfDuplex *>(context);
  /*
   * The priority-19 owner lowers the amp, disables, and deletes I2S0 before
   * acknowledging this command. Deletion—not merely DMA disable—is the pin
   * ownership fence because the microphone reuses MCLK/BCLK/WS on I2S1.
   */
  const auto suspendStatus =
      platform.audioOwner_.suspendForCapture();
  if (suspendStatus != ITERATE_KIT_OK) {
    return suspendStatus;
  }
  if (!M5.Mic.begin()) {
    /*
     * Leave the capture ledger stopped on hardware failure. Retrying from
     * inside this callback would block push-to-talk state progression and hide
     * the incident from the portable lifecycle.
     */
    platform.capture_.stop();
    (void)platform.audioOwner_.resumeAfterCapture();
    return ITERATE_KIT_IO_ERROR;
  }
  platform.microphoneActive_ = true;
  /*
   * Publish active only after hardware begins successfully. The one-frame
   * startup discard prevents microphone settling noise from reaching VAD while
   * keeping later frames continuously armed during a long button hold.
   */
  platform.capture_.start(microphoneStartupFramesToDiscard);
  return ITERATE_KIT_OK;
}

iterate_kit_status M5UnifiedHalfDuplex::stopCapture(void *context) {
  auto &platform = *static_cast<M5UnifiedHalfDuplex *>(context);
  M5.Mic.end();
  /*
   * Mic.end() releases recorder pointers before the capture ledger is reset.
   * Half-duplex playback is prepared only after that ownership boundary, which
   * avoids simultaneous peripheral state and makes release-to-audio timing
   * deterministic.
   */
  platform.capture_.stop();
  platform.microphoneActive_ = false;
  return platform.audioOwner_.resumeAfterCapture();
}

iterate_kit_status M5UnifiedHalfDuplex::stopPlayback(
    void *context) {
  auto &platform =
      *static_cast<M5UnifiedHalfDuplex *>(context);
  return platform.audioOwner_.suspendForCapture();
}

iterate_kit_status M5UnifiedHalfDuplex::flushPlayback(void *context) {
  auto &platform = *static_cast<M5UnifiedHalfDuplex *>(context);
  /*
   * stop_playback() and flush_playback() are intentionally idempotent calls
   * into the same destructive owner fence. Frames can arrive between them, so
   * the second call still revisits the lane and discards that narrow suffix.
   */
  return platform.audioOwner_.suspendForCapture();
}

iterate_kit_status M5UnifiedHalfDuplex::pollCapture(
    void *context,
    iterate_kit_audio_capture_submit_fn submit,
    void *submitContext) {
  auto &platform = *static_cast<M5UnifiedHalfDuplex *>(context);
  return platform.capture_.pump(M5.Mic, submit, submitContext);
}

}  // namespace iterate::kit::platforms
