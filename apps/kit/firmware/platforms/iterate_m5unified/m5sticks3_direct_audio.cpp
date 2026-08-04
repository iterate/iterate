#include "iterate/kit/platforms/m5sticks3_direct_audio.hpp"

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#pragma GCC diagnostic ignored "-Wvla"
#include <M5Unified.h>
#pragma GCC diagnostic pop

#include <algorithm>
#include <limits>

#include "driver/i2s_common.h"
#include "esp_err.h"
#include "esp_timer.h"
#include "freertos/idf_additions.h"

namespace iterate::kit::platforms {

namespace {

constexpr std::uint8_t es8311Address = 0x18U;
constexpr std::uint8_t m5pm1Address = 0x6eU;
constexpr std::uint32_t boardI2cFrequency = 100'000U;

/*
 * The direct path hands provider PCM to I2S without M5Unified's software
 * mixer. That omission is desirable for deadline predictability, but copying
 * M5Unified's codec setup verbatim also copied its 0 dB DAC setting while
 * silently discarding the mixer's normal attenuation. A 75%-scale physical
 * tone then drew enough speaker power to trip the board's brownout detector.
 *
 * Espressif defines ES8311 register 0x32 as 0.5 dB per step with 0xBF equal to
 * 0 dB. Apply a fixed -18 dB ceiling at the codec: arbitrary Grok/test PCM is
 * reduced before the power amplifier, while the realtime owner pays no
 * per-sample multiplication, branch, allocation, or extra memory traffic.
 * This is a board power policy, not a test-tone workaround. A future user
 * volume control may attenuate further but must not exceed this safe ceiling
 * without a new physical power proof.
 */
constexpr std::uint8_t es8311ZeroDbVolume = 0xbfU;
constexpr std::uint8_t
    es8311SafeDacAttenuationHalfDbSteps = 36U;
constexpr std::uint8_t es8311SafeDacVolume =
    es8311ZeroDbVolume - es8311SafeDacAttenuationHalfDbSteps;
static_assert(es8311SafeDacVolume == 0x9bU);

constexpr std::uint32_t cueSampleRate = 16'000U;
constexpr std::size_t cueFrameSamples =
    M5StickS3DirectI2sOps::monoSampleCount;
constexpr std::size_t cueDescriptorCount =
    M5StickS3DirectI2sOps::descriptorCount;
constexpr std::size_t cueFrameCount = 4U;
constexpr std::size_t cueNoteSamples = cueFrameSamples * 2U;
constexpr std::uint32_t cueDeadlineMs = 200U;
constexpr std::int32_t cueAmplitude = 12'000;
constexpr std::uint32_t cueEnvelopeSamples = 48U;
static_assert(
    cueDescriptorCount > cueFrameCount,
    "the bounded cue must end before cyclic DMA can wrap to its first note");

constexpr std::int16_t postCaptureCueSample(
    std::size_t absoluteSample) {
  const auto noteSample =
      static_cast<std::uint32_t>(
          absoluteSample % cueNoteSamples);
  const std::uint32_t frequency =
      absoluteSample < cueNoteSamples ? 880U : 1'320U;
  const auto phase = static_cast<std::uint32_t>(
      (static_cast<std::uint64_t>(noteSample) * frequency) %
      cueSampleRate);
  const auto halfRate = cueSampleRate / 2U;
  const std::int32_t triangle =
      phase < halfRate
      ? -cueAmplitude +
          static_cast<std::int32_t>(
              (static_cast<std::uint64_t>(phase) *
               static_cast<std::uint32_t>(cueAmplitude * 2)) /
              halfRate)
      : cueAmplitude -
          static_cast<std::int32_t>(
              (static_cast<std::uint64_t>(phase - halfRate) *
               static_cast<std::uint32_t>(cueAmplitude * 2)) /
              halfRate);
  const auto samplesUntilEnd = static_cast<std::uint32_t>(
      cueNoteSamples - 1U - noteSample);
  const auto envelope = std::min(
      cueEnvelopeSamples,
      std::min(noteSample, samplesUntilEnd));
  return static_cast<std::int16_t>(
      (triangle * static_cast<std::int32_t>(envelope)) /
      static_cast<std::int32_t>(cueEnvelopeSamples));
}

constexpr std::array<std::int16_t, cueFrameSamples>
makePostCaptureCueFrame(std::size_t frameIndex) {
  std::array<std::int16_t, cueFrameSamples> frame{};
  for (std::size_t index = 0U;
       index < frame.size();
       ++index) {
    frame[index] = postCaptureCueSample(
        frameIndex * cueFrameSamples + index);
  }
  return frame;
}

constexpr std::array<
    std::array<std::int16_t, cueFrameSamples>,
    cueFrameCount>
makePostCaptureCue() {
  std::array<
      std::array<std::int16_t, cueFrameSamples>,
      cueFrameCount> frames{};
  for (std::size_t index = 0U;
       index < frames.size();
       ++index) {
    frames[index] = makePostCaptureCueFrame(index);
  }
  return frames;
}

/*
 * Eighty milliseconds of flash-resident PCM: two gently-ramped rising notes.
 * The remaining physical DMA descriptors are preloaded with silence. Keeping
 * the audible prefix shorter than the cycle means the owner can stop after its
 * fourth exact EOF without refilling or allowing cyclic replay. Cue playback
 * therefore needs no heap, PCM FIFO, borrowed buffer, or second speaker task.
 */
constexpr auto postCaptureCueFrames = makePostCaptureCue();
static_assert(postCaptureCueFrames[0][0] == 0);
static_assert(postCaptureCueFrames[3][cueFrameSamples - 1U] == 0);

void saturatingIncrement(
    std::atomic<std::uint32_t> &counter) {
  auto current = counter.load(std::memory_order_relaxed);
  while (current !=
             std::numeric_limits<std::uint32_t>::max() &&
         !counter.compare_exchange_weak(
             current,
             current + 1U,
             std::memory_order_relaxed,
             std::memory_order_relaxed)) {
  }
}

iterate_kit_status statusFromEspError(esp_err_t error) {
  switch (error) {
    case ESP_OK:
      return ITERATE_KIT_OK;
    case ESP_ERR_INVALID_ARG:
      return ITERATE_KIT_INVALID_ARGUMENT;
    case ESP_ERR_INVALID_STATE:
      return ITERATE_KIT_STATE_ERROR;
    case ESP_ERR_NO_MEM:
    case ESP_ERR_NOT_FOUND:
      return ITERATE_KIT_LIMIT;
    case ESP_ERR_TIMEOUT:
      return ITERATE_KIT_BACKPRESSURE;
    default:
      return ITERATE_KIT_IO_ERROR;
  }
}

}  // namespace

void M5StickS3DirectI2sOps::setOwnerTask(
    TaskHandle_t ownerTask) {
  ownerTask_ = ownerTask;
}

iterate_kit_status
M5StickS3DirectI2sOps::createAndConfigure(
    void *context,
    EspIdfDirectI2sSentCallback sentCallback,
    EspIdfDirectI2sOverflowCallback overflowCallback) {
  if (context == nullptr || sentCallback == nullptr ||
      overflowCallback == nullptr ||
      ownerTask_ == nullptr || channel_ != nullptr) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  /*
   * Sixteen 320-stereo-frame descriptors are exactly 320 ms of physical
   * reserve. That value comes from a production 250 ms interarrival gap which
   * exhausted the prior 160 ms cycle; it is not an arbitrary latency budget.
   * ESP-IDF's own guidance sizes dma_desc_num from the maximum measured service
   * interval. This remains physical cyclic ownership, not a software queue;
   * the portable age fence still destroys delayed conversation history.
   * `auto_clear_before_cb` remains the safety valve: a missed refill plays
   * silence on the next wrap instead of replaying old speech. Clearing after
   * callback would race the Core-1 owner that receives descriptor ownership
   * from that callback, so it is explicitly forbidden.
   *
   * `allow_pd=false` avoids IDF's extra register backup allocation and clock
   * restoration latency. This voice target tears the channel down for
   * half-duplex microphone ownership, so light-sleep persistence would buy no
   * useful behavior.
   */
  i2s_chan_config_t channelConfiguration =
      I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  channelConfiguration.dma_desc_num = descriptorCount;
  channelConfiguration.dma_frame_num = monoSampleCount;
  channelConfiguration.auto_clear_after_cb = false;
  channelConfiguration.auto_clear_before_cb = true;
  channelConfiguration.allow_pd = false;
  channelConfiguration.intr_priority = 2;

  auto error = i2s_new_channel(
      &channelConfiguration, &channel_, nullptr);
  if (error != ESP_OK) {
    channel_ = nullptr;
    return statusFromEspError(error);
  }

  auto standardConfiguration = i2s_std_config_t{};
  standardConfiguration.clk_cfg =
      I2S_STD_CLK_DEFAULT_CONFIG(16'000U);
  standardConfiguration.clk_cfg.mclk_multiple =
      I2S_MCLK_MULTIPLE_128;
  standardConfiguration.slot_cfg =
      I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
          I2S_DATA_BIT_WIDTH_16BIT,
          I2S_SLOT_MODE_STEREO);
  standardConfiguration.gpio_cfg.mclk = GPIO_NUM_18;
  standardConfiguration.gpio_cfg.bclk = GPIO_NUM_17;
  standardConfiguration.gpio_cfg.ws = GPIO_NUM_15;
  standardConfiguration.gpio_cfg.dout = GPIO_NUM_14;
  standardConfiguration.gpio_cfg.din = I2S_GPIO_UNUSED;
  standardConfiguration.gpio_cfg.invert_flags = {};

  error = i2s_channel_init_std_mode(
      channel_, &standardConfiguration);
  if (error != ESP_OK) {
    const auto originalStatus = statusFromEspError(error);
    const auto cleanupStatus =
        deleteChannelAndClearCallbacks();
    /*
     * Failed initialization does not prove deletion. Preserve the channel
     * handle when cleanup fails so resetForPlayback() can quarantine and retry
     * it; pretending the object vanished could leave its driver task/pins live
     * while a replacement is created over them.
     */
    return cleanupStatus == ITERATE_KIT_OK
        ? originalStatus
        : cleanupStatus;
  }

  callbackContext_ = context;
  sentCallback_ = sentCallback;
  overflowCallback_ = overflowCallback;
  const i2s_event_callbacks_t callbacks{
    nullptr,
    nullptr,
    &onSent,
    &onSendQueueOverflow,
  };
  error = i2s_channel_register_event_callback(
      channel_, &callbacks, this);
  if (error != ESP_OK) {
    const auto originalStatus = statusFromEspError(error);
    const auto cleanupStatus =
        deleteChannelAndClearCallbacks();
    /*
     * IDF does not specify that every failing registration is side-effect
     * free. Callback context therefore remains quarantined beside a handle
     * whose delete failed. Clearing either one independently would invite a
     * late ISR to dereference reset or repurposed backend state.
     */
    return cleanupStatus == ITERATE_KIT_OK
        ? originalStatus
        : cleanupStatus;
  }
  return ITERATE_KIT_OK;
}

iterate_kit_status M5StickS3DirectI2sOps::release() {
  if (channel_ == nullptr) {
    return deleteChannelAndClearCallbacks();
  }

  /*
   * Disable is not the ownership boundary by itself: ESP-IDF leaves MCLK
   * routed after disable, while M5Unified's microphone needs the same
   * MCLK/BCLK/WS pins on I2S1. Only successful deletion proves those pins and
   * callback storage are no longer selected by the TX channel.
   */
  esp_err_t firstError = ESP_OK;
  if (enabled_) {
    firstError = i2s_channel_disable(channel_);
    if (firstError == ESP_OK) {
      enabled_ = false;
    }
  }
  const auto deleteStatus =
      deleteChannelAndClearCallbacks();
  if (firstError != ESP_OK) {
    return statusFromEspError(firstError);
  }
  return deleteStatus;
}

iterate_kit_status
M5StickS3DirectI2sOps::
deleteChannelAndClearCallbacks() {
  const auto deleteError = releaseOwnedHandle(
      channel_,
      ESP_OK,
      [](i2s_chan_handle_t channel) {
        return i2s_del_channel(channel);
      },
      [this]() {
        enabled_ = false;
        callbackContext_ = nullptr;
        sentCallback_ = nullptr;
        overflowCallback_ = nullptr;
      });
  return statusFromEspError(deleteError);
}

EspIdfDirectI2sIoResult
M5StickS3DirectI2sOps::preload(
    const void *stereo,
    std::size_t bytes) {
  if (channel_ == nullptr || stereo == nullptr ||
      enabled_) {
    return {ITERATE_KIT_STATE_ERROR, 0U};
  }
  std::size_t loaded = 0U;
  const auto error = i2s_channel_preload_data(
      channel_, stereo, bytes, &loaded);
  return {statusFromEspError(error), loaded};
}

iterate_kit_status M5StickS3DirectI2sOps::enable() {
  if (channel_ == nullptr || enabled_) {
    return ITERATE_KIT_STATE_ERROR;
  }
  const auto error = i2s_channel_enable(channel_);
  if (error == ESP_OK) {
    enabled_ = true;
  }
  return statusFromEspError(error);
}

EspIdfDirectI2sIoResult M5StickS3DirectI2sOps::write(
    const void *stereo,
    std::size_t bytes,
    DirectI2sDescriptorToken) {
  if (channel_ == nullptr || stereo == nullptr ||
      !enabled_) {
    return {ITERATE_KIT_STATE_ERROR, 0U};
  }
  std::size_t written = 0U;
  /*
   * Zero is intentional and non-negotiable. A blocking write would put the
   * priority-19 audio owner to sleep inside opaque driver state and make the
   * actual EOF-to-refill delay impossible to bound or report.
   */
  const auto error = i2s_channel_write(
      channel_, stereo, bytes, &written, 0U);
  return {statusFromEspError(error), written};
}

std::uint64_t
M5StickS3DirectI2sOps::monotonicMicroseconds() const {
  return static_cast<std::uint64_t>(
      esp_timer_get_time());
}

bool M5StickS3DirectI2sOps::onSent(
    i2s_chan_handle_t,
    i2s_event_data_t *event,
    void *context) {
  auto &self =
      *static_cast<M5StickS3DirectI2sOps *>(context);
  if (event != nullptr &&
      self.sentCallback_ != nullptr) {
    /*
     * Timestamp before waking the owner. Measuring after task scheduling would
     * erase exactly the starvation/jitter this instrumentation exists to
     * reveal.
     */
    return self.sentCallback_(
        self.callbackContext_,
        event->dma_buf,
        event->size,
        static_cast<std::uint64_t>(
            esp_timer_get_time()));
  }
  return false;
}

bool
M5StickS3DirectI2sOps::onSendQueueOverflow(
    i2s_chan_handle_t,
    i2s_event_data_t *,
    void *context) {
  auto &self =
      *static_cast<M5StickS3DirectI2sOps *>(context);
  if (self.overflowCallback_ != nullptr) {
    return self.overflowCallback_(
        self.callbackContext_);
  }
  return false;
}

bool
M5StickS3DirectI2sOps::notifyOwnerFromIsr() {
  BaseType_t higherPriorityTaskWoken = pdFALSE;
  if (ownerTask_ != nullptr) {
    vTaskNotifyGiveFromISR(
        ownerTask_, &higherPriorityTaskWoken);
  }
  return higherPriorityTaskWoken == pdTRUE;
}

iterate_kit_status
M5StickS3AudioBoardOps::setAmplifierEnabled(
    bool enabled) {
  /*
   * M5Unified's board bring-up has already muxed M5PM1 GPIO3 as a push-pull
   * output. Touch only its latch: repeating mux setup in the realtime
   * lifecycle adds unnecessary I2C transactions and creates more ways for a
   * partially failed start to leave the board audible.
   */
  const bool succeeded = enabled
      ? M5.In_I2C.bitOn(
            m5pm1Address,
            0x11U,
            1U << 3U,
            boardI2cFrequency)
      : M5.In_I2C.bitOff(
            m5pm1Address,
            0x11U,
            1U << 3U,
            boardI2cFrequency);
  return succeeded
      ? ITERATE_KIT_OK
      : ITERATE_KIT_IO_ERROR;
}

iterate_kit_status
M5StickS3AudioBoardOps::configureCodec() {
  struct RegisterValue {
    std::uint8_t address;
    std::uint8_t value;
  };
  static constexpr RegisterValue configuration[] = {
    {0x00U, 0x80U},
    {0x01U, 0xb5U},
    {0x02U, 0x18U},
    {0x0dU, 0x01U},
    {0x12U, 0x00U},
    {0x13U, 0x10U},
    {0x32U, es8311SafeDacVolume},
    {0x37U, 0x08U},
  };

  /*
   * Fail on the first unacknowledged register. Retrying here would make start
   * latency variable and hide a broken I2C/power state; the caller tears the
   * channel down and exposes one classified driver failure instead.
   */
  for (const auto &entry : configuration) {
    if (!M5.In_I2C.writeRegister8(
            es8311Address,
            entry.address,
            entry.value,
            boardI2cFrequency)) {
      return ITERATE_KIT_IO_ERROR;
    }
  }
  return ITERATE_KIT_OK;
}

M5StickS3AvatarOutput::M5StickS3AvatarOutput(
    M5StickS3DirectI2sOutput &output)
    : output_(output) {}

bool M5StickS3AvatarOutput::initialise() {
  if (initialised_) {
    return true;
  }
  if (!face_animator_init_with_config(
          &animator_,
          16'000U,
          &FACE_ENVELOPE_DEFAULT_CONFIG)) {
    return false;
  }
  clearPendingPoses();
  publishQuietPose();
  initialised_ = true;
  return true;
}

iterate_kit_status
M5StickS3AvatarOutput::resetForPlayback() {
  if (!initialised_) {
    return ITERATE_KIT_STATE_ERROR;
  }
  const auto status = output_.resetForPlayback();
  if (status != ITERATE_KIT_OK) {
    return status;
  }

  /*
   * A playback reset is a destructive generation boundary. Keeping analyzer
   * history here could animate a freshly connected response with the previous
   * response's release envelope, while keeping pending poses could match old
   * speech to a reused sequence. Reset both, but only after the driver proves
   * its old descriptor cycle is gone.
   */
  if (!face_animator_init_with_config(
          &animator_,
          16'000U,
          &FACE_ENVELOPE_DEFAULT_CONFIG)) {
    (void)output_.stopAndRelease();
    return ITERATE_KIT_STATE_ERROR;
  }
  clearPendingPoses();
  publishQuietPose();
  return ITERATE_KIT_OK;
}

iterate_kit_status M5StickS3AvatarOutput::preloadMono(
    const std::int16_t *samples,
    std::size_t sampleCount) {
  /*
   * Generation-zero compatibility calls do not carry a stable identity. Do
   * not invent physical lip-sync by associating them with an anonymous slot;
   * production RealtimePlayback always uses the metadata-aware overload.
   */
  return output_.preloadMono(samples, sampleCount);
}

iterate_kit_status M5StickS3AvatarOutput::preloadMono(
    const std::int16_t *samples,
    std::size_t sampleCount,
    DirectI2sFrameMetadata metadata) {
  const auto status =
      output_.preloadMono(samples, sampleCount, metadata);
  if (status == ITERATE_KIT_OK) {
    noteSubmittedPose(samples, sampleCount, metadata);
  }
  return status;
}

iterate_kit_status
M5StickS3AvatarOutput::preloadSilence() {
  return output_.preloadSilence();
}

iterate_kit_status M5StickS3AvatarOutput::start() {
  return output_.start();
}

DirectI2sCompletionPollResult
M5StickS3AvatarOutput::pollCompletionBatch() {
  const auto result = output_.pollCompletionBatch();
  if (result.status == ITERATE_KIT_OK) {
    publishCompletedPoses();
  }
  return result;
}

iterate_kit_status M5StickS3AvatarOutput::writeMono(
    const std::int16_t *samples,
    std::size_t sampleCount) {
  return output_.writeMono(samples, sampleCount);
}

iterate_kit_status M5StickS3AvatarOutput::writeMono(
    const std::int16_t *samples,
    std::size_t sampleCount,
    DirectI2sFrameMetadata metadata) {
  const auto status =
      output_.writeMono(samples, sampleCount, metadata);
  if (status == ITERATE_KIT_OK) {
    noteSubmittedPose(samples, sampleCount, metadata);
  }
  return status;
}

iterate_kit_status
M5StickS3AvatarOutput::writeSilence() {
  return output_.writeSilence();
}

iterate_kit_status
M5StickS3AvatarOutput::writeRecoverySilence() {
  return output_.writeRecoverySilence();
}

std::uint32_t
M5StickS3AvatarOutput::takeQueueOverflows() {
  return output_.takeQueueOverflows();
}

iterate_kit_status
M5StickS3AvatarOutput::stopAndRelease() {
  const auto status = output_.stopAndRelease();
  clearPendingPoses();
  publishQuietPose();
  return status;
}

bool M5StickS3AvatarOutput::lastPlaybackCompletion(
    std::size_t index,
    RealtimePlaybackDescriptorCompletion *completion) const {
  return output_.lastPlaybackCompletion(index, completion);
}

RealtimePlaybackSuccessfulRefillTiming
M5StickS3AvatarOutput::lastSuccessfulRefillTiming() const {
  return output_.lastSuccessfulRefillTiming();
}

bool M5StickS3AvatarOutput::snapshot(
    M5StickS3AvatarSnapshot *snapshot) const {
  if (snapshot == nullptr) {
    return false;
  }
  const auto before =
      posePublication_.load(std::memory_order_acquire);
  if (before == 0U || (before & 1U) != 0U) {
    return false;
  }
  const auto word0 = poseWord0_.load(std::memory_order_relaxed);
  const auto word1 = poseWord1_.load(std::memory_order_relaxed);
  const auto word2 = poseWord2_.load(std::memory_order_relaxed);
  const auto word3 = poseWord3_.load(std::memory_order_relaxed);
  const auto frameIndex =
      poseFrameIndex_.load(std::memory_order_relaxed);
  const auto playoutSamples =
      posePlayoutSamples_.load(std::memory_order_relaxed);
  const auto after =
      posePublication_.load(std::memory_order_acquire);
  if (before != after || (after & 1U) != 0U) {
    return false;
  }

  /*
   * Every shared payload word is atomic. A seqlock over an ordinary C struct
   * would still be a C++ data race even when retrying on sequence mismatch;
   * packing the compact pose into native 32-bit atomics makes the low-priority
   * display snapshot both bounded and memory-model correct on ESP32-S3.
   */
  face_pose_t pose{};
  pose.mouth_open = static_cast<std::uint8_t>(word0);
  pose.mouth_width = static_cast<std::uint8_t>(word0 >> 8U);
  pose.mouth_round = static_cast<std::uint8_t>(word0 >> 16U);
  pose.mouth_press = static_cast<std::uint8_t>(word0 >> 24U);
  pose.mouth_teeth = static_cast<std::uint8_t>(word1);
  pose.eye_open = static_cast<std::uint8_t>(word1 >> 8U);
  pose.viseme = static_cast<std::uint8_t>(word1 >> 16U);
  pose.phoneme = static_cast<std::uint8_t>(word1 >> 24U);
  pose.gaze_x = static_cast<std::int8_t>(word2);
  pose.gaze_y = static_cast<std::int8_t>(word2 >> 8U);
  pose.confidence = static_cast<std::uint8_t>(word2 >> 16U);
  pose.activity = static_cast<std::uint8_t>(word2 >> 24U);
  pose.level = static_cast<std::uint16_t>(word3);
  pose.speaking = ((word3 >> 16U) & 1U) != 0U;
  pose.frame_index = frameIndex;
  pose.playout_samples = playoutSamples;
  snapshot->pose = pose;
  snapshot->publicationSequence = after;
  return true;
}

std::uint32_t
M5StickS3AvatarOutput::droppedPoseCount() const {
  return droppedPoses_.load(std::memory_order_relaxed);
}

std::uint32_t
M5StickS3AvatarOutput::completionWithoutPoseCount() const {
  return completionsWithoutPose_.load(
      std::memory_order_relaxed);
}

void M5StickS3AvatarOutput::clearPendingPoses() {
  for (auto &pending : pendingPoses_) {
    pending = {};
  }
}

void M5StickS3AvatarOutput::noteSubmittedPose(
    const std::int16_t *samples,
    std::size_t sampleCount,
    DirectI2sFrameMetadata metadata) {
  if (samples == nullptr || metadata.generation == 0U) {
    return;
  }

  face_animator_push_pcm(&animator_, samples, sampleCount);
  face_pose_t pose{};
  if (!face_animator_snapshot(&animator_, &pose)) {
    saturatingIncrement(droppedPoses_);
    return;
  }
  for (auto &pending : pendingPoses_) {
    if (!pending.occupied) {
      pending.metadata = metadata;
      pending.pose = pose;
      pending.occupied = true;
      return;
    }
  }

  /*
   * The fixed table is sized from the physical descriptor cycle, so filling
   * it proves visual identity fell behind an audio ownership boundary. Drop
   * only the decoration and expose the incident; allocating or blocking here
   * would turn a cosmetic fault into an audible one.
   */
  saturatingIncrement(droppedPoses_);
}

void M5StickS3AvatarOutput::publishCompletedPoses() {
  for (std::size_t index = 0U;
       index < descriptorCount;
       ++index) {
    RealtimePlaybackDescriptorCompletion completion{};
    if (!output_.lastPlaybackCompletion(index, &completion)) {
      break;
    }
    if (completion.frameKind !=
        RealtimePlaybackFrameKind::content) {
      publishQuietPose();
      continue;
    }
    if (completion.frame.generation == 0U) {
      continue;
    }
    bool matched = false;
    for (auto &pending : pendingPoses_) {
      if (pending.occupied &&
          metadataEqual(pending.metadata, completion.frame)) {
        publishPose(pending.pose);
        pending = {};
        matched = true;
        break;
      }
    }
    if (!matched) {
      saturatingIncrement(completionsWithoutPose_);
    }
  }
}

void M5StickS3AvatarOutput::publishPose(
    const face_pose_t &pose) {
  auto before =
      posePublication_.load(std::memory_order_relaxed);
  if ((before & 1U) != 0U) {
    ++before;
  }
  posePublication_.store(before + 1U, std::memory_order_release);
  poseWord0_.store(
      packBytes(
          pose.mouth_open,
          pose.mouth_width,
          pose.mouth_round,
          pose.mouth_press),
      std::memory_order_relaxed);
  poseWord1_.store(
      packBytes(
          pose.mouth_teeth,
          pose.eye_open,
          pose.viseme,
          pose.phoneme),
      std::memory_order_relaxed);
  poseWord2_.store(
      packBytes(
          static_cast<std::uint8_t>(pose.gaze_x),
          static_cast<std::uint8_t>(pose.gaze_y),
          pose.confidence,
          pose.activity),
      std::memory_order_relaxed);
  poseWord3_.store(
      static_cast<std::uint32_t>(pose.level) |
          (static_cast<std::uint32_t>(pose.speaking) << 16U),
      std::memory_order_relaxed);
  poseFrameIndex_.store(
      pose.frame_index, std::memory_order_relaxed);
  posePlayoutSamples_.store(
      pose.playout_samples, std::memory_order_relaxed);
  posePublication_.store(before + 2U, std::memory_order_release);
}

void M5StickS3AvatarOutput::publishQuietPose() {
  face_pose_t quiet{};
  quiet.eye_open = 255U;
  quiet.viseme = FACE_VISEME_NONE;
  quiet.phoneme = FACE_PHONEME_NONE;
  quiet.activity = FACE_ACTIVITY_IDLE;
  publishPose(quiet);
}

bool M5StickS3AvatarOutput::metadataEqual(
    DirectI2sFrameMetadata left,
    DirectI2sFrameMetadata right) {
  return left.receivedAtMs == right.receivedAtMs &&
      left.generation == right.generation &&
      left.sequence == right.sequence;
}

std::uint32_t M5StickS3AvatarOutput::packBytes(
    std::uint8_t byte0,
    std::uint8_t byte1,
    std::uint8_t byte2,
    std::uint8_t byte3) {
  return static_cast<std::uint32_t>(byte0) |
      (static_cast<std::uint32_t>(byte1) << 8U) |
      (static_cast<std::uint32_t>(byte2) << 16U) |
      (static_cast<std::uint32_t>(byte3) << 24U);
}

iterate_kit_status M5StickS3DirectAudioOwner::begin(
    iterate_kit_pcm_lane *lane,
    RealtimePlaybackItemReleasedFn itemReleased,
    void *itemReleasedContext) {
  if (lane == nullptr || !lane->initialized ||
      itemReleased == nullptr || lane_ != nullptr || task_ != nullptr) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (playback_.bindItemReleased(
          itemReleased, itemReleasedContext) != ITERATE_KIT_OK) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (!output_.initialise()) {
    return ITERATE_KIT_STATE_ERROR;
  }
  lane_ = lane;
  commandComplete_ = xSemaphoreCreateBinaryStatic(
      &commandCompleteStorage_);
  if (commandComplete_ == nullptr) {
    lane_ = nullptr;
    return ITERATE_KIT_LIMIT;
  }
  task_ = xTaskCreateStaticPinnedToCore(
      &taskEntry,
      "iterate_audio",
      taskStack_.size(),
      this,
      realtimeTaskPriority,
      taskStack_.data(),
      &taskStorage_,
      realtimeTaskCore);
  if (task_ == nullptr) {
    lane_ = nullptr;
    commandComplete_ = nullptr;
    return ITERATE_KIT_LIMIT;
  }
  i2s_.setOwnerTask(task_);

  /*
   * Channel creation is deliberately performed by the newly-created owner,
   * not by the caller which happens to bootstrap it. Starting with this first
   * operation gives ThreadSanitizer-style host reasoning a simple invariant:
   * after begin returns, no other task ever touches policy/backend state.
   */
  return runBoundedCommand(LifecycleCommand::begin);
}

void M5StickS3DirectAudioOwner::notifyDownlinkReady() {
  if (task_ != nullptr) {
    /*
     * Notifications coalesce wakeups only. The SPSC lane remains the durable
     * source of frame count/order, so a burst cannot consume one RTOS object
     * per PCM frame or create a second hidden backlog.
     */
    xTaskNotifyGive(task_);
  }
}

RealtimePlaybackPumpResult
M5StickS3DirectAudioOwner::takePumpResult() {
  const auto edges =
      publishedEdges_.exchange(
          0U, std::memory_order_acq_rel);
  return {
    static_cast<iterate_kit_status>(
        publishedStatus_.load(
            std::memory_order_acquire)),
    (edges & frameSubmittedEdge) != 0U,
    (edges & playbackStartedEdge) != 0U};
}

RealtimePlaybackState
M5StickS3DirectAudioOwner::playbackState() const {
  return static_cast<RealtimePlaybackState>(
      publishedPlaybackState_.load(std::memory_order_acquire));
}

RealtimePlaybackMetrics
M5StickS3DirectAudioOwner::playbackMetrics() {
  /*
   * RealtimePlaybackMetrics is deliberately plain owner-local storage. A
   * synchronous snapshot is rare (normally once/second) and avoids making
   * dozens of counters atomic on every 20 ms frame.
   */
  if (runBoundedCommand(
          LifecycleCommand::snapshotMetrics) !=
      ITERATE_KIT_OK) {
    return metricsSnapshot_;
  }
  return metricsSnapshot_;
}

bool M5StickS3DirectAudioOwner::avatarSnapshot(
    M5StickS3AvatarSnapshot *snapshot) const {
  return output_.snapshot(snapshot);
}

std::uint32_t
M5StickS3DirectAudioOwner::avatarDroppedPoseCount() const {
  return output_.droppedPoseCount();
}

std::uint32_t
M5StickS3DirectAudioOwner::avatarCompletionWithoutPoseCount()
    const {
  return output_.completionWithoutPoseCount();
}

std::uint32_t
M5StickS3DirectAudioOwner::stackHighWaterBytes() const {
  return stackHighWaterBytes_.load(
      std::memory_order_acquire);
}

std::uint32_t
M5StickS3DirectAudioOwner::
generationFenceAcknowledgementTimeouts() const {
  return generationFenceAcknowledgementTimeouts_.value();
}

std::uint32_t
M5StickS3DirectAudioOwner::
lifecycleAcknowledgementTimeouts() const {
  return lifecycleAcknowledgementTimeouts_.value();
}

std::uint32_t
M5StickS3DirectAudioOwner::postCaptureCueCompletions() const {
  return postCaptureCueCompletions_.value();
}

std::uint32_t
M5StickS3DirectAudioOwner::postCaptureCueInterruptions() const {
  return postCaptureCueInterruptions_.value();
}

std::uint32_t
M5StickS3DirectAudioOwner::postCaptureCueFailures() const {
  return postCaptureCueFailures_.value();
}

iterate_kit_status
M5StickS3DirectAudioOwner::flushGeneration(
    std::uint32_t generation,
    bool connected) {
  if (generation == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  const auto wasFailed =
      generationFenceMailbox_.failed();
  const auto status = generationFenceMailbox_.request(
      GenerationFenceCommand::flushGeneration,
      generation,
      connected,
      static_cast<std::uint64_t>(
          esp_timer_get_time() / 1'000));
  if (!wasFailed &&
      generationFenceMailbox_.failed()) {
    /*
     * This counter names failure of the nonblocking reconnect fence, not a
     * codec/I2S operation which legitimately returned IO_ERROR. Observing the
     * mailbox's fail-closed transition makes the two cases distinguishable
     * without adding a second timeout state machine beside it.
     */
    generationFenceAcknowledgementTimeouts_.record();
  }
  if (status == ITERATE_KIT_UNAVAILABLE &&
      task_ != nullptr) {
    /*
     * The transport deliberately polls this fence. Waking the priority-19
     * owner and immediately returning keeps receive admission closed without
     * blocking the application/network loop behind physical I2S teardown.
     */
    xTaskNotifyGive(task_);
  }
  return status;
}

iterate_kit_status
M5StickS3DirectAudioOwner::suspendForCapture() {
  return runBoundedCommand(LifecycleCommand::suspend);
}

iterate_kit_status
M5StickS3DirectAudioOwner::resumeAfterCapture(
    M5StickS3PostCaptureCue cue) {
  return runBoundedCommand(
      LifecycleCommand::resume,
      static_cast<std::uint32_t>(cue));
}

void M5StickS3DirectAudioOwner::taskEntry(
    void *context) {
  static_cast<M5StickS3DirectAudioOwner *>(context)
      ->taskLoop();
}

void M5StickS3DirectAudioOwner::taskLoop() {
  for (;;) {
    TickType_t waitTicks = portMAX_DELAY;
    const auto beforeWaitMs =
        static_cast<std::uint64_t>(
            esp_timer_get_time() / 1'000);
    const auto prebufferWait =
        prebufferDeadline_.waitAt(beforeWaitMs);
    if (prebufferWait.bounded) {
      /*
       * Round up, never down. At 100 Hz, truncating a 1..9 ms remainder to
       * zero would spin priority 19 and starve the lower-priority driver task.
       * A zero remainder is intentionally one immediate pump at the exact
       * deadline; the policy then destroys/classifies the partial prebuffer.
       */
      waitTicks =
          prebufferWait.remainingMs == 0U
          ? 0U
          : static_cast<TickType_t>(
                (prebufferWait.remainingMs +
                 portTICK_PERIOD_MS - 1U) /
                portTICK_PERIOD_MS);
    }
    if (postCaptureCuePlaying_) {
      /*
       * EOF notifications normally wake every 20 ms. The independent absolute
       * deadline is the bounded failure path if IDF stops publishing them;
       * without it a lost callback would leave the amplifier and DMA cycle
       * running forever and the subsequent assistant response unconsumed.
       */
      const auto cueRemainingMs =
          beforeWaitMs >= cueDeadlineMs_
          ? 0U
          : cueDeadlineMs_ - beforeWaitMs;
      const auto cueWaitTicks =
          cueRemainingMs == 0U
          ? static_cast<TickType_t>(0U)
          : static_cast<TickType_t>(
                (cueRemainingMs + portTICK_PERIOD_MS - 1U) /
                portTICK_PERIOD_MS);
      if (waitTicks == portMAX_DELAY ||
          cueWaitTicks < waitTicks) {
        waitTicks = cueWaitTicks;
      }
    }
    (void)ulTaskNotifyTake(pdTRUE, waitTicks);

    /*
     * One wake owns one bounded policy pass. IDF publishes the completed DMA
     * pointer to its private queue before its ISR may yield to this task, so a
     * zero-byte refill cannot be repaired by yielding or sleeping here. Such a
     * result is an ownership/driver fault and the policy destructively resets
     * it in the same pass. This rule removes an otherwise hidden 10 ms retry
     * delay from the highest-priority audio path while leaving future work to
     * the next EOF/lane notification.
     */
    GenerationFenceMailbox::Envelope generationFence{};
    if (generationFenceMailbox_.take(
            &generationFence)) {
      const auto commandResult =
          executeGenerationFenceCommand(
              generationFence.command,
              generationFence.generation,
              generationFence.connected);
      publishPlaybackState();
      generationFenceMailbox_.complete(commandResult);
    }

    LifecycleMailbox::Envelope lifecycle{};
    if (lifecycleMailbox_.take(&lifecycle)) {
      const auto commandResult =
          executeLifecycleCommand(
              lifecycle.command,
              lifecycle.generation);
      publishPlaybackState();
      lifecycleMailbox_.complete(commandResult);
      (void)xSemaphoreGive(commandComplete_);
    }

    if (suspended_) {
      prebufferDeadline_.observe(0U, false);
      std::uint32_t discarded = 0U;
      std::uint32_t discardedItems = 0U;
      if (lane_ != nullptr) {
        const auto discardStatus =
            iterate_kit_pcm_lane_discard_downlink(
                lane_, &discarded, &discardedItems);
        if (discardStatus == ITERATE_KIT_OK) {
          suspendedFramesFlushed_.add(discarded);
          playback_.noteExternallyDiscardedItems(
              discardedItems);
        } else {
          /*
           * A malformed consumer state is not an expected interruption. Keep
           * capture isolated from playback, but publish the fault so the
           * application cannot report this generation as healthy.
           */
          publishedStatus_.store(
              discardStatus, std::memory_order_release);
        }
      }
      sampleStackHighWater();
      continue;
    }
    if (postCaptureCuePlaying_) {
      const auto cueStatus = servicePostCaptureCue(
          static_cast<std::uint64_t>(
              esp_timer_get_time() / 1'000));
      publishedStatus_.store(
          cueStatus, std::memory_order_release);
      publishPlaybackState();
      sampleStackHighWater();
      if (postCaptureCuePlaying_) {
        continue;
      }
      /*
       * A downlink wake can arrive while the motif owns DMA. Once its final
       * descriptor restores RealtimePlayback, fall through and consume that
       * already-published lane item; waiting for a second notification would
       * strand the first assistant frame indefinitely.
       */
    }
    if (lane_ == nullptr) {
      publishedStatus_.store(
          ITERATE_KIT_STATE_ERROR,
          std::memory_order_release);
      sampleStackHighWater();
      continue;
    }

    const auto nowMs =
        static_cast<std::uint64_t>(
            esp_timer_get_time() / 1'000);
    const auto result = playback_.pump(
        *lane_,
        output_,
        nowMs);
    const auto &metrics = playback_.metrics();
    prebufferDeadline_.observe(
        nowMs,
        metrics.state ==
                RealtimePlaybackState::buffering &&
            metrics.currentContentFrames > 0U);
    publishPumpResult(result);
    publishPlaybackState();
    sampleStackHighWater();
  }
}

iterate_kit_status
M5StickS3DirectAudioOwner::executeGenerationFenceCommand(
    GenerationFenceCommand command,
    std::uint32_t generation,
    bool connected) {
  (void)connected;
  switch (command) {
    case GenerationFenceCommand::flushGeneration:
      if (lane_ == nullptr || generation == 0U) {
        return ITERATE_KIT_INVALID_ARGUMENT;
      }
      if (postCaptureCuePlaying_) {
        /*
         * Reconnect teardown outranks cosmetic feedback. End the motif through
         * the same exact descriptor-release path before the generation fence
         * touches RealtimePlayback; two policies must never believe they own
         * the one I2S cycle at once.
         */
        const auto cueStatus = endPostCaptureCue(
            false, ITERATE_KIT_OK);
        if (cueStatus != ITERATE_KIT_OK) {
          return cueStatus;
        }
      }
      if (suspended_) {
        /*
         * Capture owns the shared MCLK/BCLK/WS pins, so recreating TX here
         * would violate half-duplex ownership. The socket barrier only needs
         * old speech physically stopped; record the accepted generation and
         * continuously discard its downlink until microphone release.
         */
        std::uint32_t discarded = 0U;
        std::uint32_t discardedItems = 0U;
        const auto discardStatus =
            iterate_kit_pcm_lane_discard_downlink(
                lane_, &discarded, &discardedItems);
        if (discardStatus == ITERATE_KIT_OK) {
          suspendedFramesFlushed_.add(discarded);
          playback_.noteExternallyDiscardedItems(
              discardedItems);
          currentGeneration_ = generation;
        }
        return discardStatus;
      }
      if (playback_.metrics().state ==
          RealtimePlaybackState::stopped) {
        const auto beginStatus = playback_.begin(output_);
        if (beginStatus != ITERATE_KIT_OK) {
          return beginStatus;
        }
      }
      {
        const auto status = playback_.flushGeneration(
            *lane_, output_, generation);
        if (status == ITERATE_KIT_OK) {
          currentGeneration_ = generation;
        }
        return status;
      }
  }
  return ITERATE_KIT_STATE_ERROR;
}

iterate_kit_status
M5StickS3DirectAudioOwner::executeLifecycleCommand(
    LifecycleCommand command,
    std::uint32_t argument) {
  switch (command) {
    case LifecycleCommand::begin:
      if (lane_ == nullptr || argument != 0U) {
        return ITERATE_KIT_STATE_ERROR;
      }
      suspended_ = false;
      return playback_.begin(output_);

    case LifecycleCommand::suspend:
      suspended_ = true;
      return stopAndDiscard();

    case LifecycleCommand::resume:
      if (lane_ == nullptr) {
        return ITERATE_KIT_STATE_ERROR;
      }
      if (argument > static_cast<std::uint32_t>(
              M5StickS3PostCaptureCue::turnComplete)) {
        return ITERATE_KIT_INVALID_ARGUMENT;
      }
      suspended_ = false;
      if (argument != static_cast<std::uint32_t>(
              M5StickS3PostCaptureCue::none)) {
        return beginPostCaptureCue(
            static_cast<M5StickS3PostCaptureCue>(argument),
            static_cast<std::uint64_t>(
                esp_timer_get_time() / 1'000));
      }
      return restorePlaybackAfterCue();

    case LifecycleCommand::snapshotMetrics:
      if (argument != 0U) {
        return ITERATE_KIT_INVALID_ARGUMENT;
      }
      metricsSnapshot_ = playback_.metrics();
      {
        /*
         * Reuse the same saturating value type as every other owner counter.
         * Adding the raw lane-discard total here would double-count frames
         * already classified by stop()/flushGeneration(); only the suspended
         * causal-gap counter is disjoint from the playback policy ledger.
         */
        BoundedEventCounter allGenerationFramesFlushed{};
        allGenerationFramesFlushed.add(
            metricsSnapshot_.generationFramesFlushed);
        allGenerationFramesFlushed.add(
            suspendedFramesFlushed_.value());
        metricsSnapshot_.generationFramesFlushed =
            allGenerationFramesFlushed.value();
      }
      {
        /*
         * The fixed 2 KiB public playback view has no spare wire budget for a
         * new cue object. A local DMA/codec failure is nevertheless the same
         * physical class as a provider-playback driver failure, so fold only
         * failures into that existing saturating counter. Completion and
         * intentional interruption remain owner-local diagnostics and never
         * dilute the release-blocking error signal.
         */
        BoundedEventCounter allDriverFailures{};
        allDriverFailures.add(metricsSnapshot_.driverFailures);
        allDriverFailures.add(postCaptureCueFailures_.value());
        metricsSnapshot_.driverFailures =
            allDriverFailures.value();
      }
      return ITERATE_KIT_OK;
  }
  return ITERATE_KIT_STATE_ERROR;
}

iterate_kit_status
M5StickS3DirectAudioOwner::beginPostCaptureCue(
    M5StickS3PostCaptureCue cue,
    std::uint64_t nowMs) {
  if (cue != M5StickS3PostCaptureCue::turnComplete ||
      postCaptureCuePlaying_ || lane_ == nullptr ||
      playback_.metrics().state !=
          RealtimePlaybackState::stopped) {
    return ITERATE_KIT_STATE_ERROR;
  }

  const auto resetStatus = output_.resetForPlayback();
  if (resetStatus != ITERATE_KIT_OK) {
    postCaptureCueFailures_.record();
    const auto restoreStatus = restorePlaybackAfterCue();
    return resetStatus != ITERATE_KIT_OK
        ? resetStatus
        : restoreStatus;
  }
  for (const auto &frame : postCaptureCueFrames) {
    const auto preloadStatus =
        output_.preloadMono(frame.data(), frame.size());
    if (preloadStatus != ITERATE_KIT_OK) {
      postCaptureCueFailures_.record();
      (void)output_.stopAndRelease();
      (void)restorePlaybackAfterCue();
      return preloadStatus;
    }
  }
  for (std::size_t index = cueFrameCount;
       index < cueDescriptorCount;
       ++index) {
    const auto preloadStatus = output_.preloadSilence();
    if (preloadStatus != ITERATE_KIT_OK) {
      postCaptureCueFailures_.record();
      (void)output_.stopAndRelease();
      (void)restorePlaybackAfterCue();
      return preloadStatus;
    }
  }
  const auto startStatus = output_.start();
  if (startStatus != ITERATE_KIT_OK) {
    postCaptureCueFailures_.record();
    (void)output_.stopAndRelease();
    (void)restorePlaybackAfterCue();
    return startStatus;
  }

  cueDescriptorsRemaining_ =
      static_cast<std::uint32_t>(cueFrameCount);
  cueDeadlineMs_ = nowMs + cueDeadlineMs;
  postCaptureCuePlaying_ = true;
  prebufferDeadline_.observe(0U, false);
  return ITERATE_KIT_OK;
}

iterate_kit_status
M5StickS3DirectAudioOwner::servicePostCaptureCue(
    std::uint64_t nowMs) {
  if (!postCaptureCuePlaying_ ||
      cueDescriptorsRemaining_ == 0U) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (output_.takeQueueOverflows() != 0U) {
    return endPostCaptureCue(false, ITERATE_KIT_IO_ERROR);
  }

  /*
   * Poll the underlying descriptor adapter directly. The avatar wrapper treats
   * every anonymous content completion as missing speech metadata, while this
   * fixed UI motif is intentionally not assistant speech and must keep the
   * face quiet rather than manufacture a diagnostic lip-sync failure.
   */
  const auto completion = directOutput_.pollCompletionBatch();
  if (completion.status != ITERATE_KIT_OK) {
    return endPostCaptureCue(false, completion.status);
  }
  const auto completed =
      completion.batch.newlyCompletedDescriptorCount;
  if (completed >= cueDescriptorsRemaining_) {
    cueDescriptorsRemaining_ = 0U;
    return endPostCaptureCue(true, ITERATE_KIT_OK);
  }
  cueDescriptorsRemaining_ -= completed;
  if (nowMs >= cueDeadlineMs_) {
    return endPostCaptureCue(false, ITERATE_KIT_IO_ERROR);
  }
  return ITERATE_KIT_OK;
}

iterate_kit_status
M5StickS3DirectAudioOwner::restorePlaybackAfterCue() {
  if (lane_ == nullptr) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (playback_.metrics().state ==
      RealtimePlaybackState::stopped) {
    const auto beginStatus = playback_.begin(output_);
    if (beginStatus != ITERATE_KIT_OK) {
      return beginStatus;
    }
  }
  if (currentGeneration_ != 0U &&
      playback_.acceptedGeneration() !=
          currentGeneration_) {
    return playback_.flushGeneration(
        *lane_, output_, currentGeneration_);
  }
  return ITERATE_KIT_OK;
}

iterate_kit_status
M5StickS3DirectAudioOwner::endPostCaptureCue(
    bool completed,
    iterate_kit_status cueStatus) {
  const auto releaseStatus = output_.stopAndRelease();
  postCaptureCuePlaying_ = false;
  cueDescriptorsRemaining_ = 0U;
  cueDeadlineMs_ = 0U;
  const auto restoreStatus = restorePlaybackAfterCue();

  const auto result =
      cueStatus != ITERATE_KIT_OK
      ? cueStatus
      : releaseStatus != ITERATE_KIT_OK
          ? releaseStatus
          : restoreStatus;
  if (result != ITERATE_KIT_OK) {
    postCaptureCueFailures_.record();
  } else if (completed) {
    postCaptureCueCompletions_.record();
  } else {
    postCaptureCueInterruptions_.record();
  }
  return result;
}

iterate_kit_status
M5StickS3DirectAudioOwner::runBoundedCommand(
    LifecycleCommand command,
    std::uint32_t argument) {
  if (task_ == nullptr || commandComplete_ == nullptr ||
      xTaskGetCurrentTaskHandle() == task_) {
    return ITERATE_KIT_STATE_ERROR;
  }
  (void)xSemaphoreTake(commandComplete_, 0U);

  const auto startedAtMs =
      static_cast<std::uint64_t>(
          esp_timer_get_time() / 1'000);
  for (;;) {
    const auto nowMs =
        static_cast<std::uint64_t>(
            esp_timer_get_time() / 1'000);
    const auto wasFailed = lifecycleMailbox_.failed();
    const auto status = lifecycleMailbox_.request(
        command, argument, false, nowMs);
    if (!wasFailed && lifecycleMailbox_.failed()) {
      lifecycleAcknowledgementTimeouts_.record();
    }
    if (status != ITERATE_KIT_UNAVAILABLE) {
      return status;
    }
    xTaskNotifyGive(task_);

    /*
     * Startup and microphone pin handoff truly are synchronous hardware
     * fences: the caller may not start I2S1 while TX deletion is outstanding.
     * They are nevertheless bounded. A wedged codec/driver becomes one visible
     * IO failure after one second instead of freezing the application,
     * diagnostics, and future reconnect processing forever.
     */
    const auto elapsedMs =
        nowMs >= startedAtMs
        ? nowMs - startedAtMs
        : commandAcknowledgementMs;
    if (elapsedMs >= commandAcknowledgementMs) {
      lifecycleAcknowledgementTimeouts_.record();
      lifecycleMailbox_.failClosed();
      return ITERATE_KIT_IO_ERROR;
    }
    const auto remainingMs =
        commandAcknowledgementMs - elapsedMs;
    const auto waitTicks =
        static_cast<TickType_t>(
            (remainingMs + portTICK_PERIOD_MS - 1U) /
            portTICK_PERIOD_MS);
    if (xSemaphoreTake(
            commandComplete_, waitTicks) != pdTRUE) {
      lifecycleAcknowledgementTimeouts_.record();
      lifecycleMailbox_.failClosed();
      return ITERATE_KIT_IO_ERROR;
    }
  }
}

iterate_kit_status
M5StickS3DirectAudioOwner::stopAndDiscard() {
  if (lane_ == nullptr) {
    return ITERATE_KIT_STATE_ERROR;
  }
  iterate_kit_status cueStopStatus = ITERATE_KIT_OK;
  if (postCaptureCuePlaying_) {
    /*
     * A new TALK down may arrive during the 80 ms completion motif. Capture
     * owns the shared pins immediately: destroy the cue cycle before the
     * microphone callback is acknowledged, then classify the missing tail as
     * an intentional interruption rather than pretending it completed.
     */
    cueStopStatus = output_.stopAndRelease();
    postCaptureCuePlaying_ = false;
    cueDescriptorsRemaining_ = 0U;
    cueDeadlineMs_ = 0U;
    if (cueStopStatus == ITERATE_KIT_OK) {
      postCaptureCueInterruptions_.record();
    } else {
      postCaptureCueFailures_.record();
    }
  }
  const auto stopStatus =
      playback_.stop(*lane_, output_);
  if (cueStopStatus != ITERATE_KIT_OK) {
    return cueStopStatus;
  }
  if (stopStatus != ITERATE_KIT_OK) {
    return stopStatus;
  }
  /*
   * RealtimePlayback::stop is idempotent and therefore does not revisit the
   * lane once already stopped. The outer half-duplex fence must still discard
   * frames which arrived between stop_playback, flush_playback, and Mic.begin.
   */
  std::uint32_t discarded = 0U;
  std::uint32_t discardedItems = 0U;
  const auto discardStatus =
      iterate_kit_pcm_lane_discard_downlink(
          lane_, &discarded, &discardedItems);
  if (discardStatus == ITERATE_KIT_OK) {
    playback_.noteExternallyDiscardedItems(discardedItems);
  }
  return discardStatus;
}

void M5StickS3DirectAudioOwner::publishPumpResult(
    RealtimePlaybackPumpResult result) {
  publishedStatus_.store(
      result.status, std::memory_order_release);
  std::uint32_t edges = 0U;
  if (result.frameSubmitted) {
    edges |= frameSubmittedEdge;
  }
  if (result.playbackStarted) {
    edges |= playbackStartedEdge;
  }
  if (edges != 0U) {
    publishedEdges_.fetch_or(
        edges, std::memory_order_release);
  }
}

void M5StickS3DirectAudioOwner::publishPlaybackState() {
  /*
   * UI needs only the current four-value state, not a synchronous copy of the
   * full metrics ledger. Publishing this byte at the same sole-owner boundary
   * avoids a 10 ms screen loop repeatedly rendezvousing with the priority-19
   * task. No frame, timestamp, or transition history is carried here.
   */
  publishedPlaybackState_.store(
      static_cast<std::uint8_t>(playback_.metrics().state),
      std::memory_order_release);
}

void M5StickS3DirectAudioOwner::sampleStackHighWater() {
  const auto bytes =
      uxTaskGetStackHighWaterMark(nullptr) *
      sizeof(StackType_t);
  stackHighWaterBytes_.store(
      static_cast<std::uint32_t>(bytes),
      std::memory_order_release);
}

}  // namespace iterate::kit::platforms
