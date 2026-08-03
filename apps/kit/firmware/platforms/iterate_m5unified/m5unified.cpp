#include "iterate/kit/platforms/m5unified.hpp"
#include "iterate/kit/platforms/m5sticks3_direct_audio.hpp"
#include "iterate/kit/platforms/m5sticks3_visual_layout.hpp"

#include "iterate/kit/avatar/face_keyframe.h"
#include "iterate/kit/avatar/face_render.h"

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#pragma GCC diagnostic ignored "-Wvla"
#include <M5Unified.h>
#pragma GCC diagnostic pop

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <limits>

#include "esp_heap_caps.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/task.h"

namespace iterate::kit::platforms {

static constexpr std::uint32_t m5StickS3Background = 0x000000U;

static void saturatingIncrement(std::uint32_t &value) {
  if (value != std::numeric_limits<std::uint32_t>::max()) {
    ++value;
  }
}

static std::uint32_t displayStatusColour(iterate_kit_rgb8 pixel) {
  /*
   * The shared values are deliberately dim enough for exposed physical LEDs.
   * A backlit LCD needs a modest adapter-local gain to remain legible, but it
   * must preserve hue and the shared on/off decisions. Scaling here rather
   * than in the semantic renderer keeps HAVPE and StackChan brightness safe.
   */
  constexpr std::uint16_t gain = 4U;
  const auto red = std::min<std::uint16_t>(
      static_cast<std::uint16_t>(pixel.red) * gain, 255U);
  const auto green = std::min<std::uint16_t>(
      static_cast<std::uint16_t>(pixel.green) * gain, 255U);
  const auto blue = std::min<std::uint16_t>(
      static_cast<std::uint16_t>(pixel.blue) * gain, 255U);
  return (static_cast<std::uint32_t>(red) << 16U) |
      (static_cast<std::uint32_t>(green) << 8U) |
      static_cast<std::uint32_t>(blue);
}

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
  M5.Display.setColorDepth(16);
  M5.Display.setSwapBytes(true);
  M5.Display.setBrightness(96);
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
  if (iterate_kit_cpu_usage_meter_sample(
          &cpuUsage_,
          static_cast<std::uint64_t>(startedMicroseconds_),
          aggregateIdleTime(),
          &ignoredCpuPermille) != ITERATE_KIT_OK) {
    return false;
  }

  /*
   * The sprite is a low-priority diagnostic/product sidecar, so its only full
   * frame belongs in PSRAM rather than scarce internal DMA heap. M5GFX performs
   * the synchronous panel upload before this buffer is reused; double
   * buffering would spend another 38.4 KiB merely to queue visual work that
   * should instead be skipped whenever audio is busy.
   */
  avatarFramebuffer_ = static_cast<std::uint16_t *>(heap_caps_malloc(
      FACE_RENDER_FRAME_BYTES,
      MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (avatarFramebuffer_ == nullptr ||
      !face_avatar_registry_init(&avatarRegistry_)) {
    if (avatarFramebuffer_ != nullptr) {
      heap_caps_free(avatarFramebuffer_);
      avatarFramebuffer_ = nullptr;
    }
    return false;
  }

  M5.Display.fillScreen(m5StickS3Background);
  renderCallUi(true);
  return true;
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
  if (M5.BtnB.wasPressed()) {
    /*
     * BtnB is the StickS3 top button. Only its debounced press matters for a
     * toggle; retaining releases would make an ordinary click two actions.
     */
    buttonBPressPending_ = true;
  }
}

bool M5UnifiedHalfDuplex::takeButtonAChange(bool *pressed) {
  if (pressed == nullptr || !buttonChangePending_) return false;
  *pressed = buttonPressed_;
  buttonChangePending_ = false;
  return true;
}

bool M5UnifiedHalfDuplex::takeButtonBPress() {
  if (!buttonBPressPending_) return false;
  buttonBPressPending_ = false;
  return true;
}

iterate_kit_screen_driver M5UnifiedHalfDuplex::screenDriver() {
  /*
   * Screen colour was a scaffolding proof, not a coherent product control.
   * Leave that optional driver slot empty so the profile does not advertise a
   * stale changeColour method beside the purpose-built avatar capability.
   */
  return {this, renderPngUrl, nullptr};
}

iterate_kit_avatar_driver M5UnifiedHalfDuplex::avatarDriver() {
  return {this, changeSpriteSet};
}

iterate_kit_screen_capture_driver
M5UnifiedHalfDuplex::screenCaptureDriver() {
  return {this, captureScreen};
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
    preparePlayback,
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

RealtimePlaybackState
M5UnifiedHalfDuplex::playbackState() const {
  return audioOwner_.playbackState();
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
  callUiDrawn_ = false;
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

void M5UnifiedHalfDuplex::showCallUi(
    M5StickS3CallUiState state,
    const iterate_kit_conversation_visual_state &visualState) {
  auto nextVisualState = visualState;
  if (state == M5StickS3CallUiState::speaking) {
    /*
     * Speaker amplitude is owned by the exact-DMA-completion sidecar below,
     * not by the application target's coarse lifecycle snapshot. Preserve the
     * most recently rendered physical peak until the 15 Hz visual gate accepts
     * a newer pose; otherwise the target's zero placeholder would clear the
     * ring on every 10 ms owner pass and create pointless SPI traffic.
     */
    nextVisualState.speaker_peak =
        conversationVisualState_.speaker_peak;
  }
  const bool stateChanged = state != callUiState_;
  const bool visualChanged =
      !iterate_kit_conversation_lights_equal(
          &nextVisualState, &conversationVisualState_);
  if (stateChanged) {
    callUiState_ = state;
    avatarNeedsRender_ = true;
  }
  if (visualChanged) {
    conversationVisualStateDrawn_ = false;
  }
  /*
   * View equality intentionally ignores RSSI movement inside one rendered
   * band. Retain the newest precise snapshot even when no panel write is due,
   * otherwise a later threshold comparison would start from stale telemetry.
   * Metrics remain the authoritative high-resolution observation channel.
   */
  conversationVisualState_ = nextVisualState;
  if (!stateChanged && !visualChanged &&
      callUiState_ != M5StickS3CallUiState::speaking) {
    return;
  }
  /*
   * The latch describes whether the *current state* has reached the panel; it
   * is not a generic "the screen has rendered once" bit. Clear it at the same
   * time as changing the retained model. Otherwise renderCallUi(false) sees a
   * clean view and suppresses every lifecycle repaint after BOOTING even while
   * the sockets and audio state machine continue normally in the background.
   */
  if (stateChanged) callUiDrawn_ = false;
  renderCallUi(false);
}

void M5UnifiedHalfDuplex::renderCallUi(bool force) {
  const auto nowMicroseconds = esp_timer_get_time();
  bool panelNeedsRender =
      force || !callUiDrawn_ || !conversationVisualStateDrawn_;

  M5StickS3AvatarSnapshot latestAvatar{};
  const bool hasLatestAvatar =
      audioOwner_.avatarSnapshot(&latestAvatar);
  const bool speakingPoseDue =
      callUiState_ == M5StickS3CallUiState::speaking &&
      hasLatestAvatar &&
      latestAvatar.publicationSequence != renderedAvatarPublication_ &&
      nowMicroseconds >= nextAvatarRenderMicroseconds_;

  /*
   * Full sprite generation and a 38.4 KiB panel upload are lossy side work.
   * Never perform either while the application owner is pumping microphone
   * capture. During speaker output, the priority-19 direct-I2S owner preempts
   * this task and this 15 Hz latest-only gate prevents visual catch-up work.
   * A skipped pose is therefore bounded by construction rather than waiting in
   * a display queue behind the conversation the user is trying to hear.
   */
  if (!microphoneActive_ &&
      (force || avatarNeedsRender_ || speakingPoseDue)) {
    if (renderAvatar(nowMicroseconds, force)) {
      avatarNeedsRender_ = false;
      nextAvatarRenderMicroseconds_ =
          nowMicroseconds + avatarRenderIntervalMicroseconds;
      panelNeedsRender = true;
    }
  }

  if (callUiState_ != M5StickS3CallUiState::speaking &&
      conversationVisualState_.speaker_peak != 0U) {
    conversationVisualState_.speaker_peak = 0U;
    panelNeedsRender = true;
  }

  if (!panelNeedsRender) return;
  renderStatusPanel();
  callUiDrawn_ = true;
  conversationVisualStateDrawn_ = true;
}

void M5UnifiedHalfDuplex::renderStatusPanel() {
  using Layout = M5StickS3VisualLayout;
  constexpr auto layout = Layout::make();

  const char *headline = "BOT";
  const char *instruction = "";
  const char *secondary = "";
  switch (callUiState_) {
    case M5StickS3CallUiState::booting:
      break;
    case M5StickS3CallUiState::controlConnecting:
      headline = "NET";
      instruction = "";
      secondary = "...";
      break;
    case M5StickS3CallUiState::ready:
      headline = "RDY";
      instruction = "TOP";
      secondary = "GO";
      break;
    case M5StickS3CallUiState::callConnecting:
      headline = "CON";
      instruction = "TOP";
      secondary = "END";
      break;
    case M5StickS3CallUiState::callReady:
      headline = "ON";
      instruction = "FRN";
      secondary = "HLD";
      break;
    case M5StickS3CallUiState::listening:
      headline = "MIC";
      instruction = "REL";
      secondary = "SND";
      break;
    case M5StickS3CallUiState::waitingForReply:
      headline = "AI";
      instruction = "...";
      secondary = "";
      break;
    case M5StickS3CallUiState::speaking:
      headline = "AI";
      instruction = "FRN";
      secondary = "CUT";
      break;
    case M5StickS3CallUiState::endingCall:
      headline = "END";
      instruction = "";
      secondary = "...";
      break;
    case M5StickS3CallUiState::callFailed:
      headline = "ERR";
      instruction = "TOP";
      secondary = "RST";
      break;
  }

  /*
   * Status owns only the narrow left rail. The footer was removed because it
   * made diagnostic chrome compete with the character and enlarged every
   * invalidation. The avatar has a separate latest-only cadence, so socket and
   * light transitions never erase or regenerate the face.
   */
  M5.Display.startWrite();
  M5.Display.fillRect(
      layout.sidebar.x,
      layout.sidebar.y,
      layout.sidebar.width,
      layout.sidebar.height,
      m5StickS3Background);

  iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT]{};
  iterate_kit_conversation_lights_render(
      &conversationVisualState_, pixels);
  for (std::size_t index = 0U;
       index < layout.statusRing.size();
       ++index) {
    const auto &cell = layout.statusRing[index];
    /*
     * A 3x3 package with a 1x1 semantic centre is intentionally tiny: the ring
     * stays recognizable across devices without becoming the main subject.
     * The neutral bezel preserves all twelve positions when sectors are off;
     * only the centre carries the portable colour.
     */
    M5.Display.fillRect(
        cell.x,
        cell.y,
        cell.width,
        cell.height,
        0x383838U);
    M5.Display.fillRect(
        cell.x + 1U,
        cell.y + 1U,
        cell.width - 2U,
        cell.height - 2U,
        displayStatusColour(pixels[index]));
  }

  M5.Display.setTextWrap(false);
  M5.Display.setTextColor(TFT_WHITE, m5StickS3Background);
  M5.Display.setTextSize(1);
  M5.Display.setCursor(1, 25);
  M5.Display.println(headline);
  M5.Display.setCursor(1, 48);
  M5.Display.println(instruction);
  M5.Display.setCursor(1, 58);
  M5.Display.println(secondary);
  M5.Display.endWrite();
}

bool M5UnifiedHalfDuplex::renderAvatar(
    std::int64_t nowMicroseconds,
    bool force) {
  if (avatarFramebuffer_ == nullptr) return false;

  M5StickS3AvatarSnapshot snapshot{};
  const bool hasSnapshot = audioOwner_.avatarSnapshot(&snapshot);
  if (!force &&
      callUiState_ == M5StickS3CallUiState::speaking &&
      hasSnapshot &&
      snapshot.publicationSequence == renderedAvatarPublication_) {
    return true;
  }

  face_pose_t pose{};
  pose.eye_open = 255U;
  pose.viseme = FACE_VISEME_NONE;
  pose.phoneme = FACE_PHONEME_NONE;
  if (hasSnapshot) pose = snapshot.pose;

  if (callUiState_ != M5StickS3CallUiState::speaking) {
    /*
     * A completed speech pose may remain the newest physical observation after
     * the reply ends. Activity state is authoritative for a static non-speech
     * panel, so close the mouth instead of freezing the final viseme until the
     * next call. The PCM-derived pose remains untouched in the audio owner.
     */
    pose.level = 0U;
    pose.mouth_open = 0U;
    pose.mouth_width = 0U;
    pose.mouth_round = 0U;
    pose.mouth_press = 0U;
    pose.mouth_teeth = 0U;
    pose.speaking = false;
    pose.viseme = FACE_VISEME_NONE;
    pose.phoneme = FACE_PHONEME_NONE;
  }
  switch (callUiState_) {
    case M5StickS3CallUiState::listening:
      pose.activity = FACE_ACTIVITY_LISTENING;
      break;
    case M5StickS3CallUiState::waitingForReply:
    case M5StickS3CallUiState::callConnecting:
      pose.activity = FACE_ACTIVITY_THINKING;
      break;
    case M5StickS3CallUiState::speaking:
      pose.activity = FACE_ACTIVITY_SPEAKING;
      break;
    default:
      pose.activity = FACE_ACTIVITY_IDLE;
      break;
  }

  face_render_key_t renderKey{};
  face_render_key_from_pose(&pose, &renderKey);
  const auto idleElapsed = nowMicroseconds > startedMicroseconds_
      ? static_cast<std::uint64_t>(
            nowMicroseconds - startedMicroseconds_)
      : 0U;
  const auto sampleClock =
      callUiState_ == M5StickS3CallUiState::speaking && hasSnapshot
      ? pose.playout_samples
      : static_cast<std::uint32_t>(
            (idleElapsed * captureSampleRate / 1'000'000U) &
            std::numeric_limits<std::uint32_t>::max());
  if (!face_avatar_registry_render(
          &avatarRegistry_,
          &renderKey,
          sampleClock,
          avatarFramebuffer_,
          FACE_RENDER_PIXEL_COUNT)) {
    saturatingIncrement(avatarRenderFailures_);
    return false;
  }

  constexpr auto layout = M5StickS3VisualLayout::make();
  M5.Display.startWrite();
  /*
   * Sprite assets remain one shared 160x120 render product. Let M5GFX enlarge
   * that single buffer directly onto the 180x135 destination instead of
   * allocating a second panel-sized surface or teaching the shared renderer a
   * board-specific resolution. Nearest-neighbour scaling also preserves the
   * deliberate pixel-art character of these atlases.
   */
  M5.Display.pushImageRotateZoom(
      static_cast<float>(layout.avatar.x) +
          static_cast<float>(layout.avatar.width) / 2.0F,
      static_cast<float>(layout.avatar.y) +
          static_cast<float>(layout.avatar.height) / 2.0F,
      static_cast<float>(FACE_RENDER_WIDTH) / 2.0F,
      static_cast<float>(FACE_RENDER_HEIGHT) / 2.0F,
      0.0F,
      static_cast<float>(layout.avatar.width) /
          static_cast<float>(FACE_RENDER_WIDTH),
      static_cast<float>(layout.avatar.height) /
          static_cast<float>(FACE_RENDER_HEIGHT),
      FACE_RENDER_WIDTH,
      FACE_RENDER_HEIGHT,
      avatarFramebuffer_);
  M5.Display.endWrite();
  renderedAvatarPublication_ =
      hasSnapshot ? snapshot.publicationSequence : 0U;
  conversationVisualState_.speaker_peak =
      callUiState_ == M5StickS3CallUiState::speaking
      ? pose.level
      : 0U;
  return true;
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

iterate_kit_status M5UnifiedHalfDuplex::changeSpriteSet(
    void *context, const char *slug, std::size_t slugLength) {
  auto &platform = *static_cast<M5UnifiedHalfDuplex *>(context);
  if (!face_avatar_registry_select_slug(
          &platform.avatarRegistry_, slug, slugLength)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * Selection changes only one allocation-free registry player. Rendering is
   * still latest-only side work: if PTT currently owns the application loop,
   * renderCallUi deliberately defers the new face rather than pausing capture.
   * The acknowledged capability therefore means selection was committed, not
   * that an SPI transfer preempted higher-priority audio before return.
   */
  platform.avatarNeedsRender_ = true;
  platform.renderCallUi(false);
  return ITERATE_KIT_OK;
}

iterate_kit_status M5UnifiedHalfDuplex::captureScreen(
    void *context, iterate_kit_captured_screen *capture) {
  auto &platform = *static_cast<M5UnifiedHalfDuplex *>(context);
  if (capture == nullptr) return ITERATE_KIT_INVALID_ARGUMENT;
  *capture = {};
  if (platform.capturedScreenPng_ != nullptr) {
    /*
     * There is one encoder result owner, not a screenshot queue. Cap'n Web
     * releases it after serialization; a concurrent request gets explicit
     * backpressure instead of doubling peak PSRAM or returning stale pixels.
     */
    return ITERATE_KIT_BACKPRESSURE;
  }
  if (platform.microphoneActive_) {
    /*
     * M5Unified microphone capture is pumped by this same application owner.
     * PNG compression here would pause that pump and turn a diagnostics call
     * into delayed speech. An open but currently silent call is allowed; an
     * actively held push-to-talk turn is not.
     */
    return ITERATE_KIT_BACKPRESSURE;
  }

  M5.Display.waitDisplay();
  std::size_t pngLength = 0U;
  platform.capturedScreenPng_ = M5.Display.createPng(
      &pngLength,
      0,
      0,
      M5.Display.width(),
      M5.Display.height());
  if (platform.capturedScreenPng_ == nullptr || pngLength == 0U) {
    platform.capturedScreenPng_ = nullptr;
    return ITERATE_KIT_UNAVAILABLE;
  }
  *capture = {
    static_cast<const std::uint8_t *>(platform.capturedScreenPng_),
    pngLength,
    releaseCapturedScreen,
    &platform,
  };
  return ITERATE_KIT_OK;
}

void M5UnifiedHalfDuplex::releaseCapturedScreen(void *context) {
  auto &platform = *static_cast<M5UnifiedHalfDuplex *>(context);
  /*
   * M5GFX's PNG encoder allocates through miniz (PSRAM when configured) and
   * documents ordinary free-compatible release. Clearing before free makes a
   * re-entrant failure unable to observe an apparently live second owner.
   */
  void *const encoded = platform.capturedScreenPng_;
  platform.capturedScreenPng_ = nullptr;
  std::free(encoded);
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

iterate_kit_status M5UnifiedHalfDuplex::preparePlayback(void *context) {
  auto &platform = *static_cast<M5UnifiedHalfDuplex *>(context);
  /*
   * This is intentionally the same hardware transition used after Mic.end(),
   * but exposed at the conversation boundary as well. A freshly opened call
   * can receive Grok's greeting before any PTT cycle, and the audio owner—not
   * transport arrival—is the authority on whether those samples reach DMA.
   */
  return platform.audioOwner_.resumeAfterCapture();
}

iterate_kit_status M5UnifiedHalfDuplex::pollCapture(
    void *context,
    iterate_kit_audio_capture_submit_fn submit,
    void *submitContext) {
  auto &platform = *static_cast<M5UnifiedHalfDuplex *>(context);
  return platform.capture_.pump(M5.Mic, submit, submitContext);
}

}  // namespace iterate::kit::platforms
