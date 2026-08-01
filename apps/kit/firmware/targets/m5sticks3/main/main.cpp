#include "iterate/kit/devices/m5sticks3.h"
#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/pcm_websocket.h"
#include "iterate/kit/platforms/esp_idf_configuration.h"
#include "iterate/kit/platforms/esp_idf_itx_transport.h"
#include "iterate/kit/platforms/esp_idf_pcm_transport.h"
#include "iterate/kit/platforms/esp_idf_websocket_policy.h"
#include "iterate/kit/platforms/m5sticks3_direct_audio.hpp"
#include "iterate/kit/platforms/m5unified.hpp"
#include "iterate/kit/spsc_ring.h"

#include <cstddef>
#include <cstdint>
#include <limits>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
/*
 * ESP-IDF's public Wi-Fi header deliberately contains C flexible/zero-length
 * arrays. Keep -Wpedantic for our target while treating that SDK boundary as
 * the extension-bearing system interface it is; disabling the warning for the
 * entire component would also hide accidental non-portable constructs here.
 */
#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#endif
#include "esp_wifi.h"
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

/*
 * First concrete Iterate Kit target: M5StickS3 push-to-talk voice plus a
 * mounted Cap'n Web capability at itx.kit.m5sticks3.
 *
 * The target composes reusable layers rather than teaching the core about this
 * board:
 *
 *   - the application task owns device events, Cap'n Web, capture, and
 *     synchronous speaker lifecycle commands;
 *   - a priority-19 Core-1 task exclusively owns direct-I2S playback while
 *     network work remains on Core 0/system tasks;
 *   - the control transport uses its own ESP-IDF callback/network contexts and
 *     bounded SPSC rings;
 *   - a separate PCM WebSocket/task carries only fixed-format audio frames;
 *   - M5Unified owns the physical button, microphone, and screen; direct
 *     ESP-IDF I2S owns the speaker.
 *
 * Keeping Cap'n Web and PCM on separate sockets is a product invariant, not an
 * implementation accident. RPC fragmentation, image/metrics traffic, or a
 * remount must never queue behind microphone samples, and purging stale audio
 * must not corrupt a capability session.
 *
 * `runtime` and all queues/workspaces are static. There is no application-level
 * allocation after boot, so sizeof/runtime logs and linker size reports account
 * for the memory we control. ESP-IDF/TLS/M5Unified still own opaque
 * allocations; their heap minima and classified buffer evidence are exported
 * as diagnostics instead of pretending those bytes are exactly observable.
 */
namespace {

constexpr char tag[] = "iterate-kit";
/*
 * Cap'n Web table limits are intentionally small for the MVP device surface.
 * Exhaustion is returned as an explicit protocol/resource error; growing these
 * silently would make every device pay RAM for desktop-style concurrency.
 * Metrics/high-fidelity tests should justify each future increase.
 */
constexpr std::size_t pendingCallCapacity = 8U;
constexpr std::size_t exportCapacity = 8U;
constexpr std::size_t importCapacity = 8U;
constexpr std::size_t tokenCapacity = 64U;
constexpr std::size_t outputCapacity = 128U;
constexpr std::size_t subscriptionCapacity = 2U;
/*
 * Subscription count is an API/resource limit; callback concurrency is a
 * transport limit shared across modules. Keeping them separate lets two
 * metrics observers remain registered while an urgent event waits for or
 * claims one of the two wire-safe callback slots.
 */
constexpr std::size_t callbackConcurrency = 2U;
constexpr std::size_t diagnosticsExpressionCapacity =
    ITERATE_KIT_METRICS_DIAGNOSTICS_EXPRESSION_CAPACITY;
/*
 * One NUL beyond this target's 512-byte URL limit lets the screen capability
 * copy and validate without heap allocation or truncation.
 */
constexpr std::size_t screenUrlCapacity = 513U;
/*
 * Cap'n Web represents byte arrays as base64 inside one control message. The
 * 2.8 KiB PNG ceiling leaves 256 bytes for the RPC envelope within the fixed
 * 4 KiB transport slot. The retained call UI compresses well below this bound;
 * a future arbitrary-image surface should use a chunked/blob lane rather than
 * permanently multiplying every internal control ring for rare screenshots.
 */
constexpr std::size_t maximumScreenCaptureBytes = 2'800U;
/*
 * Physical and remote device events share one bounded queue. Eight absorbs a
 * short control burst while the main task services audio; overflow remains a
 * visible device error rather than an unbounded lifecycle backlog.
 */
constexpr std::size_t eventCapacity = 8U;
/*
 * Processed button state must survive an ordinary control-socket round trip
 * without blocking capture. Matching the local event queue's eight entries
 * covers one complete accepted burst plus the subscription snapshot. If the
 * remote callback remains slow beyond that, the stream coalesces to the newest
 * state and exposes a sequence gap instead of growing a delayed control FIFO.
 */
constexpr std::size_t eventNotificationCapacity = 8U;
/*
 * Control traffic is asymmetric in ownership, but both directions need one
 * measured burst of reserve. The outbox needs eight because the shared
 * admission budget permits two callback calls, each emitting push plus pull,
 * after which the same pass may consume four inbound pulls whose resolutions
 * also need storage. The previous four-slot outbox failed that valid overlap
 * on hardware even though both WebSocket directions stayed live.
 *
 * The inbox also needs eight. A callback returns resolve+release, so two
 * admitted callbacks can contribute four incoming messages at the same tick.
 * One strictly single-flight remote call can concurrently contribute its push
 * and pull plus the prior call's release. The physical 20 Hz rig filled the
 * old four-slot inbox after 51.7 seconds and correctly—but unnecessarily—
 * replaced the Cap'n Web generation. Eight is the smallest power of two that
 * contains this seven-message causal burst.
 *
 * This spends about 5 KiB of measured internal RAM to tolerate bounded
 * scheduling/network coalescing; it does not accumulate control history.
 * Pressure beyond this reviewed burst remains an explicit terminal generation
 * error instead of an unbounded retry queue.
 */
constexpr std::size_t controlInboxSlotCount = 8U;
constexpr std::size_t controlOutboxSlotCount = 8U;
/*
 * Slot count and slot width solve different measured problems. Both
 * directions need eight messages of burst reserve, but only egress carries an
 * eight-frame, base64 VoiceLab microphone append. Ingress is bounded by the
 * peer's 2.6 KiB delivery batch plus envelope and therefore fits 4 KiB.
 *
 * Using the transport-wide 8 KiB maximum for both directions charged the
 * eight-slot inbox an impossible extra 32 KiB and made this target overflow
 * internal DRAM by 8.7 KiB at link time. Keep the rings in internal SRAM—the
 * network task relies on deterministic cache-independent mailboxes—but size
 * them for their actual wire shapes instead of moving realtime coordination to
 * PSRAM or undoing the measured eight-frame egress batching fix.
 */
constexpr std::size_t controlInboxSlotCapacity = 4096U;
constexpr std::size_t controlOutboxSlotCapacity = 8192U;
constexpr std::size_t controlMessagesPerPoll = 4U;
constexpr std::size_t controlRemoteCallLifecycleMessages = 3U;
/*
 * The wire frame is the storage unit everywhere. Partial/sample-sized slots
 * would require an extra assembler and make buffer-depth latency ambiguous.
 */
constexpr std::size_t pcmFrameBytes =
    ITERATE_KIT_PCM_V1_FRAME_BYTES;
constexpr std::size_t pcmFrameDurationMilliseconds =
    1000U * ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME /
    ITERATE_KIT_PCM_V1_SAMPLE_RATE_HZ;
/*
 * Capacity is loss reserve, not target latency. It provides two times the
 * measured 250 ms TLS send-lock envelope and absorbs tunnel delivery bursts;
 * the runtime high-water metrics show how much is actually exercised.
 *
 * Crucially, the lane/transport discard or replace an unhealthy epoch rather
 * than draining 640 ms of stale conversation after a network outage. A smaller
 * ring dropped recoverable scheduler bursts in measurement; a larger one would
 * spend RAM while making accidental FIFO recovery more harmful.
 */
constexpr std::size_t pcmUplinkCapacityMilliseconds = 640U;
constexpr std::size_t pcmDownlinkCapacityMilliseconds = 640U;
constexpr std::size_t pcmUplinkSlotCount =
    pcmUplinkCapacityMilliseconds /
    pcmFrameDurationMilliseconds;
constexpr std::size_t pcmDownlinkSlotCount =
    pcmDownlinkCapacityMilliseconds /
    pcmFrameDurationMilliseconds;
constexpr TickType_t mainLoopDelayTicks =
    pdMS_TO_TICKS(10U) == 0U ? 1U : pdMS_TO_TICKS(10U);
/*
 * The mounted path is a stable API name, independent of the transport URL.
 * Keeping device identity in the capability tree lets future lifecycle streams
 * use /devices/<slug> without coupling those event semantics to Cap'n Web.
 */
constexpr const char *mountPath[] = {"kit", "m5sticks3"};

static_assert(
    mainLoopDelayTicks > 0U,
    /*
     * A zero-delay busy loop would starve ESP-IDF idle housekeeping and make
     * CPU metrics report load caused by our scheduler rather than useful work.
     */
    "the main loop must block long enough for the idle task to run");
static_assert(
    pcmFrameDurationMilliseconds > 0U &&
        pcmUplinkCapacityMilliseconds %
                pcmFrameDurationMilliseconds ==
            0U &&
        pcmDownlinkCapacityMilliseconds %
                pcmFrameDurationMilliseconds ==
            0U,
    "PCM capacities must contain complete protocol frames");
static_assert(
    (controlInboxSlotCount & (controlInboxSlotCount - 1U)) == 0U &&
        (controlOutboxSlotCount &
         (controlOutboxSlotCount - 1U)) == 0U,
    "SPSC control slot counts must be powers of two");
static_assert(
    ((maximumScreenCaptureBytes + 2U) / 3U) * 4U + 256U <=
        controlOutboxSlotCapacity,
    "a screen capture reply must fit one bounded control message");
static_assert(
    controlOutboxSlotCapacity <=
        ITERATE_KIT_ESP_IDF_CONTROL_MESSAGE_CAPACITY,
    "the target outbox cannot exceed the audited ESP control message maximum");
static_assert(
    controlInboxSlotCount >=
        callbackConcurrency * 2U +
            controlRemoteCallLifecycleMessages,
    /*
     * Each subscription response contributes resolve+release, while the one
     * allowed remote call contributes push+pull plus the previous release.
     * This is a causal burst bound, not a throughput estimate: average control
     * rate can be low while TCP/task scheduling delivers these together.
     */
    "control inbox must cover one maximum peer burst");
static_assert(
    controlOutboxSlotCount >=
        callbackConcurrency * 2U + controlMessagesPerPoll,
    /*
     * A due callback owns a push and pull until the peer resolves it. Reserve
     * those messages before admitting the configured maximum inbound work, so
     * an RPC resolution can never be stranded behind the metrics fanout that
     * preceded it in the same application-owner pass.
     */
    "control outbox must cover one maximum owner-loop burst");
static_assert(
    (eventNotificationCapacity &
     (eventNotificationCapacity - 1U)) == 0U,
    "device event notification capacity must be a power of two");
static_assert(
    (pcmUplinkSlotCount & (pcmUplinkSlotCount - 1U)) == 0U,
    "PCM uplink slot count must be a power of two");
static_assert(
    pcmUplinkCapacityMilliseconds ==
        ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS,
    /*
     * Freshness policy may spend the finite ring reserve but must never imply
     * an unaccounted second backlog. Changing either value requires one
     * measured, reviewed change to both the RAM and latency budgets.
     */
    "PCM capture age must equal the application ring's hard bound");
static_assert(
    (pcmDownlinkSlotCount & (pcmDownlinkSlotCount - 1U)) == 0U,
    "PCM downlink slot count must be a power of two");

struct Runtime {
  /*
   * Configuration and Cap'n Web tables are application-task-owned after boot.
   * The connection object borrows every table for its complete lifetime.
   */
  iterate_kit_configuration configuration{};
  iterate_kit_itx_connection connection{};
  capnweb_pending_call pendingCalls[pendingCallCapacity]{};
  capnweb_export exports[exportCapacity]{};
  capnweb_import imports[importCapacity]{};
  capnweb_json_token tokens[tokenCapacity]{};
  char outputBuffer[outputCapacity]{};
  char screenUrlScratch[screenUrlCapacity]{};
  /*
   * A one-shot diagnostics reply can outlive the stack frame that sampled it
   * while Cap'n Web waits for the remote pull. Keep exactly one profile-owned
   * expression buffer: reconnect investigation stays allocation-free, while a
   * concurrent request is rejected instead of cloning retained state.
   */
  char diagnosticsExpression[diagnosticsExpressionCapacity]{};
  iterate_kit_metrics_subscription
      subscriptions[subscriptionCapacity]{};
  iterate_kit_device_event eventStorage[eventCapacity]{};
  iterate_kit_device_event_notification
      eventNotifications[eventNotificationCapacity]{};
  /*
   * Control rings cross application, ESP callback, and network task boundaries
   * with one producer/consumer each. Storage/length arrays are inline so the
   * exact per-direction capacity cannot change at runtime.
   */
  iterate_kit_spsc_ring controlInboxRing{};
  iterate_kit_spsc_ring controlOutboxRing{};
  std::uint8_t
      controlInboxStorage[controlInboxSlotCount]
                           [controlInboxSlotCapacity]{};
  std::uint8_t
      controlOutboxStorage[controlOutboxSlotCount]
                            [controlOutboxSlotCapacity]{};
  std::size_t controlInboxLengths[controlInboxSlotCount]{};
  std::size_t controlOutboxLengths[controlOutboxSlotCount]{};
  /*
   * The capture/application producer and PCM-network consumer own uplink; the
   * inverse pair own downlink. Align downlink bytes for the int16_t pointer
   * retained by the speaker adapter.
   */
  iterate_kit_spsc_ring pcmUplinkRing{};
  iterate_kit_spsc_ring pcmDownlinkRing{};
  iterate_kit_pcm_uplink_slot
      pcmUplinkStorage[pcmUplinkSlotCount]{};
  iterate_kit_pcm_downlink_slot
      pcmDownlinkStorage[pcmDownlinkSlotCount]{};
  std::size_t pcmUplinkLengths[pcmUplinkSlotCount]{};
  std::size_t pcmDownlinkLengths[pcmDownlinkSlotCount]{};
  iterate_kit_pcm_lane pcmLane{};
  /*
   * Platform transports own their internal task/handle state; the main task
   * only invokes their documented poll/notification APIs. `platform` and
   * `device` remain application-task-only.
   */
  iterate_kit_esp_idf_itx_transport transport{};
  iterate_kit_esp_idf_pcm_transport pcmTransport{};
  iterate::kit::platforms::M5StickS3DirectAudioOwner
      audioOwner;
  iterate::kit::platforms::M5UnifiedHalfDuplex
      platform{audioOwner};
  iterate_kit_m5sticks3 device{};
  iterate_kit_esp_idf_itx_transport_state lastTransportState =
      ITERATE_KIT_ESP_IDF_ITX_IDLE;
  iterate_kit_esp_idf_pcm_transport_state lastPcmTransportState =
      ITERATE_KIT_ESP_IDF_PCM_IDLE;
  /*
   * Last-state fields suppress repetitive fault logs without suppressing the
   * underlying saturating metrics. A transition remains visible once; a
   * continuing incident remains queryable without serial-log storms stealing
   * audio CPU.
   */
  iterate_kit_status lastPlaybackStatus = ITERATE_KIT_OK;
  /*
   * This sequence describes samples, not audio frames. It is application-task
   * owned because the same task invokes the metrics driver and Cap'n Web
   * serializer. Keeping it non-atomic avoids putting diagnostic bookkeeping on
   * the priority-19 audio owner; saturation is visible and cannot masquerade
   * as a reboot-era wrap.
   */
  std::uint32_t playbackMetricsSequence = 0U;
  bool pcmTransportStarted = false;
  bool pcmTransportStartAttempted = false;
  /*
   * "Waiting for AI" is a conversational fact which neither the transport nor
   * I2S state can infer: the playback owner is deliberately pre-buffer-ready
   * before a person has spoken. The event observer sets this only after a
   * successfully processed PTT release and clears it on the next turn/call or
   * first returned speech. One bit avoids inventing a second event queue.
   */
  bool turnAwaitingReply = false;
};

Runtime runtime;

iterate::kit::platforms::M5StickS3CallUiState
selectCallUiState(Runtime &state) {
  using iterate::kit::platforms::M5StickS3CallUiState;
  using iterate::kit::platforms::RealtimePlaybackState;

  const bool conversationActive =
      iterate_kit_m5sticks3_is_conversation_active(&state.device);
  if (!conversationActive) {
    if (state.pcmTransport.state ==
        ITERATE_KIT_ESP_IDF_PCM_FAILED) {
      return M5StickS3CallUiState::callFailed;
    }
    return state.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY &&
            state.pcmTransportStarted &&
            state.pcmTransport.state ==
                ITERATE_KIT_ESP_IDF_PCM_READY
        ? M5StickS3CallUiState::ready
        : M5StickS3CallUiState::controlConnecting;
  }

  if (state.pcmTransport.state ==
          ITERATE_KIT_ESP_IDF_PCM_FAILED ||
      state.platform.playbackState() ==
          RealtimePlaybackState::failed) {
    return M5StickS3CallUiState::callFailed;
  }
  if (iterate_kit_m5sticks3_is_capturing(&state.device)) {
    return M5StickS3CallUiState::listening;
  }
  if (!state.pcmTransportStarted ||
      state.pcmTransport.state !=
          ITERATE_KIT_ESP_IDF_PCM_READY) {
    return M5StickS3CallUiState::callConnecting;
  }
  if (state.platform.playbackState() ==
      RealtimePlaybackState::playing) {
    return M5StickS3CallUiState::speaking;
  }
  if (state.turnAwaitingReply) {
    return M5StickS3CallUiState::waitingForReply;
  }
  return M5StickS3CallUiState::callReady;
}

iterate_kit_status downlinkGenerationBarrier(
    void *context,
    std::uint32_t generation,
    bool connected) {
  auto &state = *static_cast<Runtime *>(context);
  /*
   * transport_poll() runs on the application/M5Unified owner and must never
   * wait behind codec/I2S work. The direct owner therefore exposes this as a
   * poll: UNAVAILABLE keeps receive admission closed; OK is the later physical
   * acknowledgement that old speaker pointers and queued lane frames are gone.
   */
  return state.platform.flushPlaybackGeneration(
      generation, connected);
}

void downlinkReady(void *context) {
  auto &state = *static_cast<Runtime *>(context);
  /*
   * PCM receive runs outside the audio owner. A task notification is a
   * constant-space wake hint, not a frame counter; the bounded lane remains
   * the source of truth. No socket callback performs a PCM copy or touches
   * speaker hardware.
   */
  state.platform.notifyPlaybackReady();
}

iterate_kit_status sendAudioEvent(
    void *context,
    iterate_kit_audio_event event) {
  auto &state = *static_cast<Runtime *>(context);
  iterate_kit_status status = ITERATE_KIT_OK;
  /*
   * PTT release is mirrored through Cap'n Web, while PCM uses an independent
   * socket. Even healthy networks may deliver the control edge before the
   * final microphone frame. The audio controller invokes CAPTURE_ENDED only
   * after hardware capture has stopped; publishing an empty PCM item here puts
   * a causal fence behind every frame this same application producer accepted.
   * Userspace commits Grok's manual input buffer only after it has observed
   * both boundaries, regardless of their cross-socket arrival order.
   *
   * This cannot be an out-of-band atomic flag: the PCM network consumer could
   * observe that flag before older ring slots and clip the turn. Nor can it be
   * a WebSocket PING: PONG is hop liveness, not an application media boundary.
   * A full ring makes the boundary ambiguous, so the lane requests a
   * destructive generation reset and this callback reports the failure rather
   * than allowing userspace to commit incomplete speech.
   */
  if (event == ITERATE_KIT_AUDIO_CAPTURE_ENDED) {
    if (state.pcmTransport.state !=
        ITERATE_KIT_ESP_IDF_PCM_READY) {
      status = ITERATE_KIT_BACKPRESSURE;
    } else {
      status =
          iterate_kit_pcm_lane_submit_uplink_end_marker_at(
              &state.pcmLane,
              static_cast<std::uint64_t>(
                  esp_timer_get_time() / 1000));
      if (status == ITERATE_KIT_OK ||
          status == ITERATE_KIT_BACKPRESSURE) {
        iterate_kit_esp_idf_pcm_transport_notify_uplink(
            &state.pcmTransport);
      }
    }
  }

  /*
   * The device-event subsystem separately mirrors the physical lifecycle to
   * userspace. This transition-only line remains a serial fallback and makes
   * the PCM-fence outcome visible without logging from the network/audio ISR.
   */
  ESP_LOGI(
      tag,
      "would_post_to_stream event=audio.%d source=system result=%d",
      static_cast<int>(event),
      static_cast<int>(status));
  return status;
}

iterate_kit_status sendPcm(
    void *context,
    const std::int16_t *samples,
    std::size_t sampleCount,
    std::uint32_t sampleRate,
    iterate_kit_audio_send_complete_fn complete,
    void *completeContext) {
  auto &state = *static_cast<Runtime *>(context);
  if (samples == nullptr ||
      sampleCount != ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME ||
      sampleRate !=
          iterate::kit::platforms::M5UnifiedHalfDuplex::captureSampleRate ||
      complete == nullptr) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (state.pcmTransport.state !=
      ITERATE_KIT_ESP_IDF_PCM_READY) {
    /*
     * DNS/TLS/WebSocket connect is intentionally bounded but can occupy the
     * PCM owner for seconds. Publishing microphone frames during that interval
     * would fill the 640 ms application ring even though none can be current
     * by the time a socket exists. Reject this completed frame at the producer
     * boundary instead. BoundedCapture releases and rearms its two DMA buffers,
     * so capture remains live without retaining an outage backlog; the audio
     * controller records the exact drop as expected backpressure.
     *
     * This callback and `pcmTransport.state` are both main-task-owned. A socket
     * can still disappear just after READY is observed, but the network owner
     * then purges that at-most-one scheduling-window suffix as part of its
     * generation reset.
     */
    return ITERATE_KIT_BACKPRESSURE;
  }
  /*
   * Capture is already 16 kHz / 320 samples, exactly the PCM v1 wire format.
   * Copy directly into the fixed uplink lane and timestamp at application
   * acceptance; on-device resampling/chunk aggregation would add CPU, storage,
   * and an avoidable source of capture-to-egress delay.
   *
   * This timestamp is not an I2S sample clock: it proves when the completed
   * frame reached the lane. Hardware-specific sample age must be measured by a
   * deeper driver timestamp if that distinction becomes material.
   */
  const iterate_kit_status status =
      iterate_kit_pcm_lane_submit_uplink_at(
          &state.pcmLane,
          samples,
          sampleCount * sizeof(*samples),
          static_cast<std::uint64_t>(
              esp_timer_get_time() / 1000));
  if (status == ITERATE_KIT_BACKPRESSURE) {
    /*
     * The lane has requested an epoch reset. Wake its single consumer so it can
     * purge without making the audio producer mutate consumer state. Clearing
     * the ring here would violate SPSC ownership and could race a partial
     * WebSocket write.
     */
    iterate_kit_esp_idf_pcm_transport_notify_uplink(
        &state.pcmTransport);
  }
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  iterate_kit_esp_idf_pcm_transport_notify_uplink(
      &state.pcmTransport);
  /*
   * Completion means the lane now owns a copy, not that TLS, Grok, or the peer
   * received it. The transport exposes separate acceptance/confirmation age
   * metrics; conflating these stages would hide network backlog.
   */
  complete(completeContext, ITERATE_KIT_OK);
  return ITERATE_KIT_OK;
}

/*
 * Several device-local counters are 64-bit because they may run for the whole
 * process lifetime, while the public sample deliberately uses bounded 32-bit
 * values so every callback fits one fixed control slot. Wrapping would make an
 * unhealthy endurance run look newly healthy, so UINT32_MAX means "at least
 * this many" and remains sticky in both conversion and aggregation.
 */
std::uint32_t saturatingMetricValue(std::uint64_t value) {
  constexpr auto maximum =
      static_cast<std::uint64_t>(
          std::numeric_limits<std::uint32_t>::max());
  return value > maximum
      ? std::numeric_limits<std::uint32_t>::max()
      : static_cast<std::uint32_t>(value);
}

std::uint32_t addMetricValue(
    std::uint32_t current, std::uint64_t value) {
  const auto maximum =
      std::numeric_limits<std::uint32_t>::max();
  if (current >= maximum) return maximum;
  const auto available =
      static_cast<std::uint64_t>(maximum - current);
  return value > available
      ? maximum
      : current + static_cast<std::uint32_t>(value);
}

iterate_kit_status sampleRuntimeMetrics(
    void *context, iterate_kit_metrics_sample *sample) {
  if (context == nullptr || sample == nullptr) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  auto &state = *static_cast<Runtime *>(context);
  const iterate_kit_metrics_driver platformMetrics =
      state.platform.metricsDriver();
  const iterate_kit_status platformStatus =
      platformMetrics.sample(platformMetrics.context, sample);
  if (platformStatus != ITERATE_KIT_OK) {
    /*
     * Do not publish a half-valid sample. A missing platform baseline (heap,
     * stack, CPU, uptime) makes later audio counters hard to interpret under
     * memory/CPU pressure, so the subscription sees an explicit failure.
     */
    return platformStatus;
  }

  struct iterate_kit_esp_idf_pcm_transport_metrics pcm{};
  iterate_kit_esp_idf_pcm_transport_metrics(
      &state.pcmTransport, &pcm);
  struct iterate_kit_esp_idf_itx_transport_metrics control{};
  iterate_kit_esp_idf_itx_transport_metrics(
      &state.transport, &control);
  const iterate_kit_audio_metrics *const audio =
      iterate_kit_m5sticks3_audio_metrics(&state.device);
  const auto playback = state.platform.playbackMetrics();

  sample->has_audio = true;
  if (audio != nullptr) {
    sample->audio.capture.sent =
        saturatingMetricValue(audio->capture_frames_sent);
    sample->audio.capture.dropped =
        saturatingMetricValue(audio->capture_frames_dropped);
    std::uint32_t captureFailures =
        saturatingMetricValue(audio->capture_send_failures);
    captureFailures = addMetricValue(
        captureFailures, audio->event_send_failures);
    sample->audio.capture.failures = addMetricValue(
        captureFailures, audio->completion_protocol_errors);
  }
  sample->audio.uplink.sent =
      saturatingMetricValue(pcm.uplink_frames_sent);
  sample->audio.uplink.dropped = addMetricValue(
      saturatingMetricValue(pcm.uplink_frames_discarded),
      pcm.lane.uplink.producer_backpressure);
  sample->audio.uplink.depth =
      saturatingMetricValue(pcm.lane.uplink.current_slots);
  sample->audio.uplink.high_water =
      saturatingMetricValue(pcm.lane.uplink.high_water_slots);
  sample->audio.uplink.failures =
      saturatingMetricValue(pcm.uplink_send_failures);
  sample->audio.uplink.send_deferrals =
      saturatingMetricValue(pcm.uplink_send_deferrals);
  sample->audio.uplink.consecutive_send_deferrals =
      saturatingMetricValue(pcm.uplink_consecutive_send_deferrals);
  sample->audio.uplink.maximum_consecutive_send_deferrals =
      saturatingMetricValue(
          pcm.uplink_maximum_consecutive_send_deferrals);
  sample->audio.uplink.restart_incidents =
      saturatingMetricValue(pcm.uplink_restart_incidents);
  sample->audio.uplink.in_place_freshness_recoveries =
      saturatingMetricValue(
          pcm.uplink_in_place_freshness_recoveries);
  sample->audio.uplink.socket_restarts =
      saturatingMetricValue(pcm.uplink_socket_restarts);
  sample->audio.uplink.producer_backpressure_restarts =
      saturatingMetricValue(
          pcm.uplink_producer_backpressure_restarts);
  sample->audio.uplink.transport_disconnect_restarts =
      saturatingMetricValue(
          pcm.uplink_transport_disconnect_restarts);
  sample->audio.uplink.no_progress_timeout_restarts =
      saturatingMetricValue(
          pcm.uplink_no_progress_timeout_restarts);
  sample->audio.uplink.frame_send_timeout_restarts =
      saturatingMetricValue(pcm.uplink_frame_send_timeout_restarts);
  sample->audio.uplink.capture_stale_restarts =
      saturatingMetricValue(pcm.uplink_capture_stale_restarts);
  sample->audio.uplink.last_transport_accept_age_ms =
      saturatingMetricValue(pcm.uplink_last_transport_accept_age_ms);
  sample->audio.uplink.maximum_transport_accept_age_ms =
      saturatingMetricValue(
          pcm.uplink_maximum_transport_accept_age_ms);
  sample->audio.uplink.last_restart_oldest_capture_age_ms =
      saturatingMetricValue(
          pcm.uplink_last_restart_oldest_capture_age_ms);
  sample->audio.uplink.last_restart_reason =
      iterate_kit_pcm_uplink_restart_reason_name(
          pcm.uplink_last_restart_reason);
  sample->audio.uplink.last_restart_frames_discarded =
      saturatingMetricValue(
          pcm.uplink_last_restart_frames_discarded);
  sample->audio.downlink.received =
      saturatingMetricValue(pcm.lane.downlink_frames_accepted);
  /*
   * A generation boundary intentionally destroys obsolete assistant speech;
   * `playback.generationFramesFlushed` below owns that exact conservation
   * ledger, including frames still in the lane. Reporting the same expected
   * barge-in as `downlink.dropped` would turn a healthy interruption into a
   * transport fault and violate the rule that error telemetry contains only
   * defects. Producer backpressure remains a real unplanned downlink loss.
   */
  sample->audio.downlink.dropped = saturatingMetricValue(pcm.lane.downlink.producer_backpressure);
  sample->audio.downlink.depth =
      saturatingMetricValue(pcm.lane.downlink.current_slots);
  sample->audio.downlink.high_water =
      saturatingMetricValue(pcm.lane.downlink.high_water_slots);
  sample->audio.downlink.failures =
      saturatingMetricValue(pcm.downlink_receive_failures);
  sample->audio.playback.submitted =
      saturatingMetricValue(playback.dmaFramesSubmitted);
  sample->audio.playback.completed =
      saturatingMetricValue(playback.dmaFramesCompleted);
  std::uint32_t playbackFlushed =
      saturatingMetricValue(
          playback.generationFramesFlushed);
  playbackFlushed = addMetricValue(
      playbackFlushed, playback.freshnessFramesDropped);
  playbackFlushed = addMetricValue(
      playbackFlushed,
      playback.partialPrebufferFramesDropped);
  playbackFlushed = addMetricValue(
      playbackFlushed, playback.underrunFramesFlushed);
  /*
   * A frame discarded because its physical slot was already replaced by
   * recovery silence is still lost speech. Keep the compact general view
   * conservative while the detailed v2 callback preserves the distinct
   * silence-submitted/completed/drop counters needed to diagnose why.
   */
  playbackFlushed = addMetricValue(
      playbackFlushed, playback.underrunLateFramesDropped);
  sample->audio.playback.flushed = addMetricValue(
      playbackFlushed, playback.fatalFramesFlushed);
  sample->audio.playback.depth =
      saturatingMetricValue(playback.currentContentFrames);
  sample->audio.playback.high_water =
      saturatingMetricValue(playback.highWaterContentFrames);
  std::uint32_t playbackFailures =
      saturatingMetricValue(playback.driverFailures);
  playbackFailures = addMetricValue(
      playbackFailures, playback.invalidFrames);
  playbackFailures = addMetricValue(
      playbackFailures, playback.ownerClockRegressions);
  sample->audio.playback.failures = addMetricValue(
      playbackFailures, playback.stateErrors);
  sample->audio.has_playback = true;
  sample->audio.protocol_failures =
      saturatingMetricValue(pcm.protocol_failures);
  /*
   * Copy the transport's classifications verbatim. Promoting an opaque
   * TLS/Wi-Fi layer to "observed" here would be worse than omitting it: a
   * dashboard could report zero latency while bytes remain hidden below us.
   * `has_buffers` is set only after all layers have been populated, preventing
   * a partially initialized public object.
   */
  sample->audio.buffers.uplink_application =
      pcm.buffers.uplink_application;
  sample->audio.buffers.websocket_transmitter =
      pcm.buffers.websocket_transmitter;
  sample->audio.buffers.lwip_send =
      pcm.buffers.lwip_send;
  sample->audio.buffers.tls_egress =
      pcm.buffers.tls_egress;
  sample->audio.buffers.wifi_egress =
      pcm.buffers.wifi_egress;
  sample->audio.has_buffers = true;

  /*
   * The detailed callback is populated from this same coherent sample. A
   * second metrics driver call would repeat the synchronous audio-owner
   * rendezvous, spend control CPU, and allow general/detailed subscribers to
   * disagree solely because one sampled a frame later.
   */
  auto &detail = sample->playback_detail;
  sample->has_playback_detail = true;
  detail.schema_version = 5U;
  if (state.playbackMetricsSequence <
      std::numeric_limits<std::uint32_t>::max()) {
    ++state.playbackMetricsSequence;
  }
  detail.sequence = state.playbackMetricsSequence;
  detail.produced_at_ms = sample->uptime_ms;
  detail.downlink_accepted =
      saturatingMetricValue(pcm.lane.downlink_frames_accepted);
  detail.playback.downlink_interarrival_samples =
      saturatingMetricValue(
          pcm.lane.downlink_interarrival_samples);
  detail.playback.maximum_downlink_interarrival_ms =
      saturatingMetricValue(
          pcm.lane.downlink_maximum_interarrival_ms);

#define COPY_PLAYBACK_METRIC(target_name, source_name)                    \
  detail.playback.target_name =                                          \
      saturatingMetricValue(playback.source_name)

  COPY_PLAYBACK_METRIC(frames_dequeued, framesDequeued);
  COPY_PLAYBACK_METRIC(submitted, dmaFramesSubmitted);
  COPY_PLAYBACK_METRIC(completed, dmaFramesCompleted);
  COPY_PLAYBACK_METRIC(
      generation_frames_flushed, generationFramesFlushed);
  COPY_PLAYBACK_METRIC(
      freshness_frames_dropped, freshnessFramesDropped);
  COPY_PLAYBACK_METRIC(
      partial_prebuffer_frames_dropped,
      partialPrebufferFramesDropped);
  COPY_PLAYBACK_METRIC(
      underrun_frames_flushed, underrunFramesFlushed);
  COPY_PLAYBACK_METRIC(underrun_incidents, underrunIncidents);
  COPY_PLAYBACK_METRIC(
      underrun_silence_frames_submitted,
      underrunSilenceFramesSubmitted);
  COPY_PLAYBACK_METRIC(
      underrun_silence_frames_completed,
      underrunSilenceFramesCompleted);
  COPY_PLAYBACK_METRIC(
      underrun_silence_frames_retired,
      underrunSilenceFramesRetired);
  COPY_PLAYBACK_METRIC(
      underrun_late_frames_dropped,
      underrunLateFramesDropped);
  COPY_PLAYBACK_METRIC(
      dma_deadline_miss_incidents, dmaDeadlineMissIncidents);
  COPY_PLAYBACK_METRIC(freshness_incidents, freshnessIncidents);
  COPY_PLAYBACK_METRIC(
      partial_prebuffer_incidents, partialPrebufferIncidents);
  COPY_PLAYBACK_METRIC(
      end_of_stream_markers_consumed,
      endOfStreamMarkersConsumed);
  COPY_PLAYBACK_METRIC(
      end_of_stream_responses, endOfStreamResponses);
  COPY_PLAYBACK_METRIC(
      end_of_stream_silence_descriptors,
      endOfStreamSilenceDescriptors);
  COPY_PLAYBACK_METRIC(
      end_of_stream_padding_descriptors_completed,
      endOfStreamPaddingDescriptorsCompleted);
  COPY_PLAYBACK_METRIC(
      driver_queue_overflow_incidents,
      driverQueueOverflowIncidents);
  COPY_PLAYBACK_METRIC(driver_failures, driverFailures);
  COPY_PLAYBACK_METRIC(driver_stop_failures, driverStopFailures);
  COPY_PLAYBACK_METRIC(
      fatal_frames_flushed, fatalFramesFlushed);
  COPY_PLAYBACK_METRIC(
      write_backpressure_incidents,
      writeBackpressureIncidents);
  COPY_PLAYBACK_METRIC(
      write_backpressure_destructive_resets,
      writeBackpressureDestructiveResets);
  COPY_PLAYBACK_METRIC(
      write_backpressure_frames_dropped,
      writeBackpressureFramesDropped);
  COPY_PLAYBACK_METRIC(invalid_frames, invalidFrames);
  COPY_PLAYBACK_METRIC(state_errors, stateErrors);
  /*
   * Both timestamps in the public timing view use the same monotonic ESP
   * clock. A regression at either the network producer or the I2S owner makes
   * its corresponding latency maximum untrustworthy, so expose their
   * saturating sum through the existing fatal acceptance counter instead of
   * leaving the new ingress classifier as device-private state.
   */
  detail.playback.owner_clock_regressions = addMetricValue(
      saturatingMetricValue(playback.ownerClockRegressions),
      pcm.lane.downlink_interarrival_clock_regressions);
  COPY_PLAYBACK_METRIC(
      current_content_frames, currentContentFrames);
  COPY_PLAYBACK_METRIC(
      high_water_content_frames, highWaterContentFrames);
  COPY_PLAYBACK_METRIC(
      last_receive_to_dma_ms, lastReceiveToDmaMs);
  COPY_PLAYBACK_METRIC(
      maximum_receive_to_dma_ms, maximumReceiveToDmaMs);
  COPY_PLAYBACK_METRIC(
      receive_to_dma_start_samples, receiveToDmaStartSamples);
  COPY_PLAYBACK_METRIC(
      last_receive_to_dma_start_ms, lastReceiveToDmaStartMs);
  COPY_PLAYBACK_METRIC(
      maximum_receive_to_dma_start_ms,
      maximumReceiveToDmaStartMs);
  COPY_PLAYBACK_METRIC(
      completion_timing_samples, completionTimingSamples);
  COPY_PLAYBACK_METRIC(
      last_eof_to_owner_us, lastEofToOwnerUs);
  COPY_PLAYBACK_METRIC(
      maximum_eof_to_owner_us, maximumEofToOwnerUs);
  COPY_PLAYBACK_METRIC(
      last_earliest_reuse_lead_us, lastEarliestReuseLeadUs);
  COPY_PLAYBACK_METRIC(
      minimum_earliest_reuse_lead_us,
      minimumEarliestReuseLeadUs);
  COPY_PLAYBACK_METRIC(
      successful_refill_timing_samples,
      successfulRefillTimingSamples);
  COPY_PLAYBACK_METRIC(
      last_eof_to_successful_refill_us,
      lastEofToSuccessfulRefillUs);
  COPY_PLAYBACK_METRIC(
      maximum_eof_to_successful_refill_us,
      maximumEofToSuccessfulRefillUs);
  COPY_PLAYBACK_METRIC(
      last_write_call_duration_us, lastWriteCallDurationUs);
  COPY_PLAYBACK_METRIC(
      maximum_write_call_duration_us,
      maximumWriteCallDurationUs);
  COPY_PLAYBACK_METRIC(
      last_reuse_lead_at_successful_refill_us,
      lastReuseLeadAtSuccessfulRefillUs);
  COPY_PLAYBACK_METRIC(
      minimum_reuse_lead_at_successful_refill_us,
      minimumReuseLeadAtSuccessfulRefillUs);
#undef COPY_PLAYBACK_METRIC
  detail.playback.state =
      static_cast<std::uint32_t>(playback.state);

  /*
   * Heap totals alone do not answer whether the next DMA descriptor or TLS
   * allocation can succeed. Report both current/minimum DMA-capable memory and
   * largest contiguous blocks. These are synchronous allocator counters—not a
   * heap walk or allocation—and are sampled on the lower-priority owner.
   */
  constexpr std::uint32_t dmaHeapCapabilities =
      MALLOC_CAP_8BIT | MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL;
  constexpr std::uint32_t internalHeapCapabilities =
      MALLOC_CAP_8BIT | MALLOC_CAP_INTERNAL;
  detail.runtime.audio_owner_stack_headroom_bytes =
      state.audioOwner.stackHighWaterBytes();
  detail.runtime.main_stack_headroom_bytes =
      uxTaskGetStackHighWaterMark(nullptr) * sizeof(StackType_t);
  detail.runtime.control_network_stack_headroom_bytes =
      control.network_task_stack_high_water_bytes;
  detail.runtime.pcm_network_stack_headroom_bytes =
      pcm.network_task_stack_high_water_bytes;
  detail.runtime.free_internal_heap_bytes =
      sample->free_internal_heap_bytes;
  detail.runtime.minimum_free_internal_heap_bytes =
      sample->minimum_free_internal_heap_bytes;
  detail.runtime.free_dma_heap_bytes =
      heap_caps_get_free_size(dmaHeapCapabilities);
  detail.runtime.minimum_free_dma_heap_bytes =
      heap_caps_get_minimum_free_size(dmaHeapCapabilities);
  detail.runtime.largest_free_internal_heap_block_bytes =
      heap_caps_get_largest_free_block(internalHeapCapabilities);
  detail.runtime.largest_free_dma_block_bytes =
      heap_caps_get_largest_free_block(dmaHeapCapabilities);
  detail.runtime.cpu_permille = sample->cpu_permille;
  detail.runtime.generation_fence_acknowledgement_timeouts =
      state.audioOwner.generationFenceAcknowledgementTimeouts();
  detail.runtime.lifecycle_acknowledgement_timeouts =
      state.audioOwner.lifecycleAcknowledgementTimeouts();
  detail.runtime.control_network_stack_exhaustions =
      control.network_task_stack_exhaustions;
  detail.runtime.pcm_network_stack_exhaustions =
      pcm.network_task_stack_exhaustions;
  /*
   * Reuse the transport's existing atomics rather than timing or logging the
   * network loop. Their deltas form a passive causal ladder: task read
   * attempts, positive raw chunks, then complete frames in downlinkAccepted.
   * Instrumenting each iteration with another clock read would make the probe
   * itself part of the scheduling problem we are trying to explain.
   */
  detail.runtime.pcm_receive_calls =
      pcm.websocket_receive_calls;
  detail.runtime.pcm_receive_chunks =
      pcm.websocket_receive_chunks;
  detail.runtime.control_network_max_work_cycles =
      control.network_task_max_work_cycles;
  detail.runtime.pcm_network_max_work_cycles =
      pcm.network_task_max_work_cycles;

  /*
   * The recurring callbacks die with the failed control WebSocket. Preserve
   * the ESP transport's fixed latest incident in this same synchronous sample
   * so the replacement Cap'n Web generation can ask what killed its
   * predecessor. None of these reads add logging or work to the audio task.
   */
  auto &diagnostics = sample->control_diagnostics;
  sample->has_control_diagnostics = true;
  diagnostics.schema_version = 3U;
  diagnostics.produced_at_ms = sample->uptime_ms;
  diagnostics.websocket_start_attempts =
      control.websocket_start_attempts;
  diagnostics.websocket_connections =
      control.websocket_connections;
  diagnostics.websocket_disconnects =
      control.websocket_disconnects;
  diagnostics.websocket_errors = control.websocket_errors;
  diagnostics.wifi_disconnects = control.wifi_disconnects;
  diagnostics.protocol_failures = control.protocol_failures;
  diagnostics.control_receive_failures =
      control.control_receive_failures;
  diagnostics.control_send_failures =
      control.control_send_failures;
  diagnostics.last_wifi_disconnect_reason =
      control.last_wifi_disconnect_reason;
  diagnostics.last_websocket_error_generation =
      control.last_websocket_error_generation;
  diagnostics.last_websocket_error_type =
      control.last_websocket_error_type;
  diagnostics.last_websocket_tls_error =
      control.last_websocket_tls_error;
  diagnostics.last_websocket_tls_stack_error =
      control.last_websocket_tls_stack_error;
  diagnostics.last_websocket_transport_errno =
      control.last_websocket_transport_errno;
  diagnostics.last_websocket_handshake_status_code =
      control.last_websocket_handshake_status_code;
  diagnostics.last_websocket_close_status_code =
      control.last_websocket_close_status_code;
  diagnostics.protocol_failure_generation =
      control.protocol_failure_generation;
  diagnostics.last_application_capnweb_generation =
      control.last_application_capnweb_generation;
  diagnostics.last_application_capnweb_status =
      control.last_application_capnweb_status;
  diagnostics.last_control_receive_status =
      control.last_control_receive_status;
  diagnostics.control_messages_sent =
      control.control_messages_sent;
  diagnostics.control_messages_discarded =
      control.control_messages_discarded;
  diagnostics.control_inbox_discarded =
      control.control_inbox_discarded;
  diagnostics.control_outbox_discarded =
      control.control_outbox_discarded;
  diagnostics.control_inbox.capacity_slots =
      control.control_inbox_capacity_slots;
  diagnostics.control_inbox.messages_published =
      control.control_inbox.messages_published;
  diagnostics.control_inbox.messages_consumed =
      control.control_inbox.messages_consumed;
  diagnostics.control_inbox.producer_backpressure =
      control.control_inbox.producer_backpressure;
  diagnostics.control_inbox.high_water_slots =
      control.control_inbox.high_water_slots;
  diagnostics.control_inbox.current_slots =
      control.control_inbox.current_slots;
  diagnostics.control_outbox.capacity_slots =
      control.control_outbox_capacity_slots;
  diagnostics.control_outbox.messages_published =
      control.control_outbox.messages_published;
  diagnostics.control_outbox.messages_consumed =
      control.control_outbox.messages_consumed;
  diagnostics.control_outbox.producer_backpressure =
      control.control_outbox.producer_backpressure;
  diagnostics.control_outbox.high_water_slots =
      control.control_outbox.high_water_slots;
  diagnostics.control_outbox.current_slots =
      control.control_outbox.current_slots;
  diagnostics.network.wifi_connected = control.wifi_connected;
  diagnostics.network.pcm_websocket_connections =
      pcm.websocket_connections;
  diagnostics.network.pcm_websocket_disconnects =
      pcm.websocket_disconnects;
  diagnostics.network.pcm_websocket_errors =
      pcm.websocket_errors;
  /*
   * AP info is sampled here on the low-rate application/diagnostics path, never
   * in the PCM network or audio-owner tasks. A roam can make this lookup fail
   * even while the transport's association flag has not changed; in that case
   * absence is the only honest RSSI evidence. The platform baseline cleared
   * the whole sample above, so a failed lookup cannot leak the prior second's
   * value.
   */
  wifi_ap_record_t accessPoint{};
  if (esp_wifi_sta_get_ap_info(&accessPoint) == ESP_OK) {
    diagnostics.network.has_wifi_rssi_dbm = true;
    diagnostics.network.wifi_rssi_dbm =
        static_cast<std::int32_t>(accessPoint.rssi);
  }
  return ITERATE_KIT_OK;
}

void observeDeviceEvent(
    void *context,
    const iterate_kit_device_event *event,
    iterate_kit_status result) {
  auto &state = *static_cast<Runtime *>(context);
  /*
   * Physical and remotely injected actions pass through the same device event
   * dispatcher before reaching this observer. Logging both source and result
   * proves that symmetry now and preserves the shape of the future stream
   * mirror without adding a second behavior path.
   */
  ESP_LOGI(
      tag,
      "would_post_to_stream event=%s source=%s result=%d",
      iterate_kit_device_event_type_name(
          static_cast<iterate_kit_device_event_type>(event->type)),
      iterate_kit_device_event_source_name(
          static_cast<iterate_kit_device_event_source>(event->source)),
      static_cast<int>(result));
  if (result != ITERATE_KIT_OK) return;

  /*
   * Update the display's one-bit turn intent only after the shared dispatcher
   * accepted the physical/remote action. Updating on a raw GPIO edge would let
   * an event-queue or hardware failure paint a state the audio controller never
   * entered. This observer is already the post-dispatch convergence point for
   * both sources, so it adds no alternate control path.
   */
  switch (static_cast<iterate_kit_device_event_type>(event->type)) {
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED:
      state.turnAwaitingReply = true;
      break;
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED:
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED:
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED:
      state.turnAwaitingReply = false;
      break;
    case ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT:
      /* Publishers validate this sentinel; retain fail-closed exhaustiveness. */
      break;
  }
}

void deviceSessionEnded(void *context) {
  auto &state = *static_cast<Runtime *>(context);
  /*
   * Imports/exports are scoped to one Cap'n Web session. Tell the device peer
   * before a reconnect can mount it again so subscriptions and remote handles
   * cannot leak across authentication generations.
   */
  iterate_kit_peer_session_ended(&state.device.peer);
}

bool initialiseRings(Runtime &state) {
  /*
   * Initialize every ownership boundary before any task is started. The
   * all-or-nothing chain is safe because failure occurs during boot while no
   * producer/consumer can observe the partially initialized later rings.
   */
  return iterate_kit_spsc_ring_init(
             &state.controlInboxRing,
             state.controlInboxStorage,
             controlInboxSlotCapacity,
             controlInboxSlotCount,
             state.controlInboxLengths) == ITERATE_KIT_OK &&
      iterate_kit_spsc_ring_init(
             &state.controlOutboxRing,
             state.controlOutboxStorage,
             controlOutboxSlotCapacity,
             controlOutboxSlotCount,
             state.controlOutboxLengths) == ITERATE_KIT_OK &&
      iterate_kit_spsc_ring_init(
             &state.pcmUplinkRing,
             state.pcmUplinkStorage,
             sizeof(state.pcmUplinkStorage[0]),
             pcmUplinkSlotCount,
             state.pcmUplinkLengths) == ITERATE_KIT_OK &&
      iterate_kit_spsc_ring_init(
             &state.pcmDownlinkRing,
             state.pcmDownlinkStorage,
             sizeof(state.pcmDownlinkStorage[0]),
             pcmDownlinkSlotCount,
             state.pcmDownlinkLengths) == ITERATE_KIT_OK &&
      iterate_kit_pcm_lane_init(
             &state.pcmLane,
             &state.pcmUplinkRing,
             &state.pcmDownlinkRing) == ITERATE_KIT_OK &&
      state.platform.bindPcmLane(&state.pcmLane) ==
          ITERATE_KIT_OK;
}

bool initialiseDevice(Runtime &state) {
  /*
   * This options object is only a wiring description; every referenced storage
   * block lives in static Runtime. A one-second metrics cadence gives useful
   * delay/memory trends without turning diagnostics into dominant control
   * traffic or allocating an unbounded subscription history.
   */
  const iterate_kit_m5sticks3_options options{
    state.platform.screenDriver(),
    state.screenUrlScratch,
    sizeof(state.screenUrlScratch),
    state.platform.screenCaptureDriver(),
    maximumScreenCaptureBytes,
    {
      &state.connection.session,
      {
        &state,
        sampleRuntimeMetrics,
      },
      state.subscriptions,
      subscriptionCapacity,
      1000U,
      state.diagnosticsExpression,
      sizeof(state.diagnosticsExpression),
      nullptr,
    },
    {
      ITERATE_KIT_AUDIO_PUSH_TO_TALK,
      state.platform.audioHardware(),
      {
        &state,
        sendAudioEvent,
        sendPcm,
      },
      state.platform.audioCaptureDriver(),
    },
    state.eventStorage,
    eventCapacity,
    {
      &state.connection.session,
      state.eventNotifications,
      eventNotificationCapacity,
      nullptr,
    },
    {
      &state,
      observeDeviceEvent,
    },
    /*
     * Each callback owns push+pull outbound and may return resolve+release.
     * Two concurrent callbacks consume four messages per direction, leaving
     * the remainder of each eight-slot ring for the proven bounded RPC burst.
     */
    callbackConcurrency,
  };
  return iterate_kit_m5sticks3_init(
             &state.device, &options) == CAPNWEB_OK;
}

bool initialiseConnection(Runtime &state) {
  iterate_kit_esp_idf_itx_transport_options transportOptions{};
  transportOptions.configuration = &state.configuration;
  transportOptions.connection = &state.connection;
  transportOptions.control_inbox = &state.controlInboxRing;
  transportOptions.control_outbox = &state.controlOutboxRing;
  if (iterate_kit_esp_idf_itx_transport_prepare(
          &state.transport, &transportOptions) != ITERATE_KIT_OK) {
    return false;
  }
  /*
   * PCM and Cap'n Web deliberately receive the same immutable project
   * configuration but independent transports/queues. Sharing credentials does
   * not imply sharing scheduling or reconnect generations.
   */
  iterate_kit_esp_idf_pcm_transport_options
      pcmTransportOptions{};
  pcmTransportOptions.configuration = &state.configuration;
  pcmTransportOptions.device_id = "m5sticks3";
  pcmTransportOptions.lane = &state.pcmLane;
  pcmTransportOptions.downlink_generation_barrier =
      downlinkGenerationBarrier;
  pcmTransportOptions.downlink_generation_barrier_context =
      &state;
  pcmTransportOptions.downlink_ready = downlinkReady;
  pcmTransportOptions.downlink_ready_context = &state;
  if (iterate_kit_esp_idf_pcm_transport_prepare(
          &state.pcmTransport,
          &pcmTransportOptions) != ITERATE_KIT_OK) {
    return false;
  }

  iterate_kit_itx_connection_options connectionOptions{};
  connectionOptions.pending_calls = state.pendingCalls;
  connectionOptions.pending_call_count = pendingCallCapacity;
  connectionOptions.exports = state.exports;
  connectionOptions.export_count = exportCapacity;
  connectionOptions.imports = state.imports;
  connectionOptions.import_count = importCapacity;
  connectionOptions.tokens = state.tokens;
  connectionOptions.token_count = tokenCapacity;
  connectionOptions.outbound_buffer = state.outputBuffer;
  connectionOptions.outbound_buffer_size = outputCapacity;
  connectionOptions.send_text =
      iterate_kit_esp_idf_itx_transport_send_text;
  connectionOptions.send_text_context = &state.transport;
  connectionOptions.project_id = state.configuration.project_id;
  connectionOptions.project_api_key =
      state.configuration.project_api_key;
  connectionOptions.mount_path = mountPath;
  connectionOptions.mount_path_count =
      sizeof(mountPath) / sizeof(mountPath[0]);
  connectionOptions.capability =
      iterate_kit_m5sticks3_capability(&state.device);
  /*
   * Mount the device root as one capability object rather than synthesizing a
   * fake nested RPC tree in the target. The portable device library defines
   * methods/events; this target only chooses its stable mount path and drivers.
   */
  connectionOptions.session_ended = deviceSessionEnded;
  connectionOptions.session_ended_context = &state;
  return iterate_kit_itx_connection_init(
             &state.connection, &connectionOptions) == CAPNWEB_OK;
}

}  // namespace

extern "C" void app_main(void) {
  /*
   * app_main remains the sole owner of device, Cap'n Web, M5 input/display,
   * and capture for the process lifetime. Direct playback has its own
   * statically allocated owner; cross-task data remains in the PCM lane.
   */
  if (!runtime.platform.begin()) {
    ESP_LOGE(tag, "expected M5StickS3 hardware was not detected");
    return;
  }
  const iterate_kit_esp_configuration_result configurationResult =
      iterate_kit_esp_read_configuration(&runtime.configuration);
  if (configurationResult.status !=
      ITERATE_KIT_ESP_CONFIGURATION_OK) {
    ESP_LOGW(
        tag,
        "device is not provisioned: storage=%s decode=%s platform=%ld",
        iterate_kit_esp_configuration_status_name(
            configurationResult.status),
        iterate_kit_configuration_error_name(
            configurationResult.configuration_error),
        static_cast<long>(configurationResult.platform_error));
    runtime.platform.showStatus("Needs provisioning", 0U, 0U);
    /*
     * Provisioning failure is terminal for this boot. Retrying flash reads or
     * starting an unauthenticated local server would waste CPU and broaden the
     * attack surface; the browser/CLI flasher installs a complete new image and
     * resets the device.
     */
    return;
  }
  ESP_LOGI(tag, "provisioning configuration loaded");

  if (!initialiseRings(runtime) ||
      !initialiseDevice(runtime) ||
      !initialiseConnection(runtime)) {
    ESP_LOGE(tag, "bounded device runtime initialization failed");
    runtime.platform.showStatus("Initialization failed", 0U, 0U);
    return;
  }
  /*
   * Start control networking only after every callback target and queue exists.
   * Reversing this order would let ESP-IDF publish a connection event into
   * partially initialized Cap'n Web/device state.
   */
  if (iterate_kit_esp_idf_itx_transport_start(
          &runtime.transport) != ITERATE_KIT_OK) {
    ESP_LOGE(
        tag,
        "network transport start failed: platform=%ld",
        static_cast<long>(runtime.transport.last_platform_error));
    runtime.platform.showStatus("Network start failed", 0U, 0U);
    return;
  }

  ESP_LOGI(
      tag,
      "runtime ready: static_bytes=%u event_bytes=%u "
      "event_delivery_bytes=%u control_bytes=%u "
      "pcm_ring_bytes=%u platform_bytes=%u control_transport_bytes=%u "
      "pcm_transport_bytes=%u",
      static_cast<unsigned int>(sizeof(runtime)),
      static_cast<unsigned int>(sizeof(runtime.eventStorage)),
      static_cast<unsigned int>(
          sizeof(runtime.eventNotifications)),
      static_cast<unsigned int>(
          sizeof(runtime.controlInboxStorage) +
          sizeof(runtime.controlOutboxStorage)),
      static_cast<unsigned int>(
          sizeof(runtime.pcmUplinkStorage) +
          sizeof(runtime.pcmDownlinkStorage)),
      static_cast<unsigned int>(sizeof(runtime.platform)),
      static_cast<unsigned int>(sizeof(runtime.transport)),
      static_cast<unsigned int>(sizeof(runtime.pcmTransport)));
  /*
   * The log above is a compile/runtime bridge for memory regressions: it
   * reports all static application-owned storage by layer. Heap minima emitted
   * through metrics cover opaque allocations made after this point.
   */
  for (;;) {
    /*
     * Each operation below is independently bounded. Local button edges enter
     * the device queue before its bounded poll so capture reacts in this loop,
     * ahead of capability/control bursts. Downlink notifications wake the
     * dedicated audio owner directly; the PCM task has a separate uplink
     * notification. This loop's 10 ms timeout is control-plane liveness and a
     * yield for ESP-IDF idle housekeeping, not the speaker service cadence.
     */
    runtime.platform.update();
    if (runtime.platform.takeButtonBPress()) {
      /*
       * Button B (the small top button on StickS3) owns call lifetime. It is
       * deliberately edge-triggered: a press toggles one conversation, while
       * holding it cannot oscillate the socket state as M5Unified is polled.
       * Remote tests publish through the same event dispatcher, so the
       * physical control is not a privileged second implementation.
       */
      const bool nextConversationActive =
          !iterate_kit_m5sticks3_is_conversation_active(
              &runtime.device);
      const iterate_kit_status status =
          iterate_kit_m5sticks3_publish_conversation(
              &runtime.device,
              nextConversationActive,
              ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL);
      if (status != ITERATE_KIT_OK) {
        ESP_LOGE(
            tag,
            "physical conversation publish failed: %d",
            static_cast<int>(status));
      }
    }

    bool pressed = false;
    if (runtime.platform.takeButtonAChange(&pressed)) {
      /*
       * Button A (the front face) is a level, not a toggle: capture begins
       * while held and the release commits the turn. Publishing B before A
       * makes a simultaneous call-start/hold sample deterministic. Physical
       * and remote PTT enter the same dispatcher so tests exercise the exact
       * audio state machine used by the GPIO.
       */
      const iterate_kit_status status =
          iterate_kit_m5sticks3_publish_push_to_talk(
              &runtime.device,
              pressed,
              ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL);
      if (status != ITERATE_KIT_OK) {
        ESP_LOGE(
            tag,
            "physical push-to-talk publish failed: %d",
            static_cast<int>(status));
      }
    }

    const auto nowMicroseconds = esp_timer_get_time();
    const iterate_kit_poll_result devicePoll =
        iterate_kit_m5sticks3_poll(
            &runtime.device,
            static_cast<std::uint64_t>(nowMicroseconds / 1000));
    if (devicePoll.status != ITERATE_KIT_POLL_OK) {
      ESP_LOGE(
          tag,
          "device poll failed: status=%d capnweb=%d",
          static_cast<int>(devicePoll.status),
          static_cast<int>(devicePoll.capnweb_status));
    }

    const iterate_kit_status transportPoll =
        iterate_kit_esp_idf_itx_transport_poll(
            &runtime.transport, controlMessagesPerPoll);
    if (transportPoll != ITERATE_KIT_OK &&
        runtime.transport.state != runtime.lastTransportState) {
      ESP_LOGE(
          tag,
          "transport transition failed: state=%s status=%d capnweb=%d",
          iterate_kit_esp_idf_itx_transport_state_name(
              runtime.transport.state),
          static_cast<int>(transportPoll),
          static_cast<int>(
              runtime.transport.last_capnweb_status));
    }
    if (runtime.transport.state != runtime.lastTransportState) {
      ESP_LOGI(
          tag,
          "transport state=%s",
          iterate_kit_esp_idf_itx_transport_state_name(
              runtime.transport.state));
      runtime.lastTransportState = runtime.transport.state;
    }

    if (!runtime.pcmTransportStarted &&
        !runtime.pcmTransportStartAttempted &&
        runtime.transport.state == ITERATE_KIT_ESP_IDF_ITX_READY) {
      /*
       * DNS/TCP/TLS/WebSocket setup measured 5.52 seconds on the physical
       * Stick, so it is device-readiness work, not something Button B may put
       * on a person's interactive path. Start the independent PCM lane once
       * after the authenticated Cap'n Web mount proves configuration. The PCM
       * task then owns bounded reconnects and freshness resets for the device
       * lifetime; hang-up retires only Grok in userspace and never queues or
       * replays audio here.
       *
       * The one-shot flag covers only an impossible local start failure such
       * as static-task creation failure. Retrying that from the 10 ms owner
       * loop would be an unbounded storm; network failures after a successful
       * start are already explicitly governed by the transport retry gate.
       */
      runtime.pcmTransportStartAttempted = true;
      const iterate_kit_status startStatus =
          iterate_kit_esp_idf_pcm_transport_start(
              &runtime.pcmTransport);
      if (startStatus == ITERATE_KIT_OK) {
        runtime.pcmTransportStarted = true;
      } else {
        ESP_LOGE(
            tag,
            "pcm transport start failed: status=%d platform=%ld",
            static_cast<int>(startStatus),
            static_cast<long>(
                runtime.pcmTransport.last_platform_error));
      }
    }
    if (runtime.pcmTransportStarted) {
      const iterate_kit_status pcmTransportPoll =
          iterate_kit_esp_idf_pcm_transport_poll(
              &runtime.pcmTransport);
      if (pcmTransportPoll != ITERATE_KIT_OK &&
          runtime.pcmTransport.state !=
              runtime.lastPcmTransportState) {
        ESP_LOGE(
            tag,
            "pcm transport transition failed: state=%s status=%d "
            "platform=%ld",
            iterate_kit_esp_idf_pcm_transport_state_name(
                runtime.pcmTransport.state),
            static_cast<int>(pcmTransportPoll),
            static_cast<long>(
                runtime.pcmTransport.last_platform_error));
      }
      if (runtime.pcmTransport.state !=
          runtime.lastPcmTransportState) {
        ESP_LOGI(
            tag,
            "pcm transport state=%s",
            iterate_kit_esp_idf_pcm_transport_state_name(
                runtime.pcmTransport.state));
        runtime.lastPcmTransportState =
            runtime.pcmTransport.state;
      }
    }

    const auto playbackPoll = runtime.platform.pollPlayback();
    /*
     * This only consumes coalesced status/lifecycle edges from Core 1. The
     * actual pump has already run at audio priority; during push-to-talk that
     * owner discards downlink so speech cannot wait behind the user's turn.
     */
    if (playbackPoll.status != ITERATE_KIT_OK &&
        playbackPoll.status != ITERATE_KIT_UNAVAILABLE &&
        playbackPoll.status != runtime.lastPlaybackStatus) {
      ESP_LOGE(
          tag,
          "playback poll failed: status=%d",
          static_cast<int>(playbackPoll.status));
    }
    runtime.lastPlaybackStatus = playbackPoll.status;
    if (playbackPoll.playbackStarted) {
      runtime.turnAwaitingReply = false;
      const iterate_kit_status playbackStatus =
          iterate_kit_m5sticks3_note_playback_started(
              &runtime.device);
      if (playbackStatus != ITERATE_KIT_OK) {
        ESP_LOGE(
            tag,
            "playback lifecycle update failed: status=%d",
            static_cast<int>(playbackStatus));
      }
    }

    /*
     * This call is intentionally unconditional while its implementation is
     * transition-gated. The view therefore follows remote and physical events,
     * reconnects, and audio-owner edges without scattering display writes
     * through those paths or continuously stealing time from audio.
     */
    runtime.platform.showCallUi(selectCallUiState(runtime));

    (void)ulTaskNotifyTake(pdFALSE, mainLoopDelayTicks);
    /*
     * Notifications are intentionally coalesced. Rings/state machines contain
     * the durable work; treating notification counts as frame counts would
     * either lose work or force an unbounded wake backlog under high-rate PCM.
     */
  }
}
