#include "iterate/kit/platforms/m5sticks3_direct_audio.hpp"

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#pragma GCC diagnostic ignored "-Wvla"
#include <M5Unified.h>
#pragma GCC diagnostic pop

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
   * Four 320-stereo-frame descriptors are exactly 80 ms of physical reserve.
   * `auto_clear_before_cb` is the safety valve: a missed refill plays silence
   * on the next wrap instead of replaying old speech. Clearing after callback
   * would race the Core-1 owner that receives descriptor ownership from that
   * callback, so it is explicitly forbidden.
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

iterate_kit_status M5StickS3DirectAudioOwner::begin(
    iterate_kit_pcm_lane *lane) {
  if (lane == nullptr || !lane->initialized ||
      lane_ != nullptr || task_ != nullptr) {
    return ITERATE_KIT_INVALID_ARGUMENT;
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
M5StickS3DirectAudioOwner::resumeAfterCapture() {
  return runBoundedCommand(LifecycleCommand::resume);
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
          executeLifecycleCommand(lifecycle.command);
      publishPlaybackState();
      lifecycleMailbox_.complete(commandResult);
      (void)xSemaphoreGive(commandComplete_);
    }

    if (suspended_) {
      prebufferDeadline_.observe(0U, false);
      std::uint32_t discarded = 0U;
      if (lane_ != nullptr) {
        const auto discardStatus =
            iterate_kit_pcm_lane_discard_downlink(
            lane_, &discarded);
        if (discardStatus == ITERATE_KIT_OK) {
          suspendedFramesFlushed_.add(discarded);
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
      if (suspended_) {
        /*
         * Capture owns the shared MCLK/BCLK/WS pins, so recreating TX here
         * would violate half-duplex ownership. The socket barrier only needs
         * old speech physically stopped; record the accepted generation and
         * continuously discard its downlink until microphone release.
         */
        std::uint32_t discarded = 0U;
        const auto discardStatus =
            iterate_kit_pcm_lane_discard_downlink(
                lane_, &discarded);
        if (discardStatus == ITERATE_KIT_OK) {
          suspendedFramesFlushed_.add(discarded);
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
    LifecycleCommand command) {
  switch (command) {
    case LifecycleCommand::begin:
      if (lane_ == nullptr) {
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
        const auto generationStatus =
            playback_.flushGeneration(
                *lane_, output_, currentGeneration_);
        if (generationStatus != ITERATE_KIT_OK) {
          return generationStatus;
        }
      }
      suspended_ = false;
      return ITERATE_KIT_OK;

    case LifecycleCommand::snapshotMetrics:
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
      return ITERATE_KIT_OK;
  }
  return ITERATE_KIT_STATE_ERROR;
}

iterate_kit_status
M5StickS3DirectAudioOwner::runBoundedCommand(
    LifecycleCommand command) {
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
        command, 0U, false, nowMs);
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
  const auto stopStatus =
      playback_.stop(*lane_, output_);
  if (stopStatus != ITERATE_KIT_OK) {
    return stopStatus;
  }
  /*
   * RealtimePlayback::stop is idempotent and therefore does not revisit the
   * lane once already stopped. The outer half-duplex fence must still discard
   * frames which arrived between stop_playback, flush_playback, and Mic.begin.
   */
  std::uint32_t discarded = 0U;
  return iterate_kit_pcm_lane_discard_downlink(
      lane_, &discarded);
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
