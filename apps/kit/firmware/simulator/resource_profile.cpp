#include "iterate/kit/devices/stackchan.h"
#include "iterate/kit/devices/m5sticks3.h"
#include "iterate/kit/platforms/bounded_event_counter.hpp"
#include "iterate/kit/platforms/direct_i2s_stereo_output.hpp"
#include "iterate/kit/platforms/esp_idf_direct_i2s_backend.hpp"
#include "iterate/kit/platforms/m5unified.hpp"
#include "iterate/kit/platforms/realtime_owner_control.hpp"
#include "iterate/kit/platforms/realtime_playback.hpp"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>

#include <sys/resource.h>

namespace {

/*
 * This executable provides two deliberately different classes of evidence:
 *
 *  - sizeof-based values are exact for this compiler/ABI and the explicitly
 *    enumerated caller-owned objects;
 *  - elapsed host time and process peak RSS are coarse regression signals.
 *
 * Neither host nanoseconds nor RSS is an ESP32 cycle/heap measurement. They can
 * catch a dramatic parser or allocation regression before device testing, but
 * target map files, runtime high-water metrics, and on-device timing remain the
 * authority. Keeping those evidence classes separate prevents a convenient
 * desktop benchmark from being mistaken for realtime or memory-pressure proof.
 */
constexpr std::size_t iterations = 100'000U;

/*
 * The benchmark supplies every Cap'n Web table and scratch buffer explicitly,
 * preserving the firmware library's no-allocator contract. Tight table counts
 * exercise steady-state release/reuse instead of granting the host effectively
 * unbounded resources. A 128-byte output scratch deliberately forces streaming
 * fragments; increasing it until every reply fits would hide incremental
 * encoder assumptions that matter on a small target.
 *
 * These capacities define the reported model. They are not total device RAM:
 * task stacks, TLS/lwIP/Wi-Fi, camera/display drivers, allocator metadata, and
 * platform-owned DMA buffers are outside this portable working set.
 */
constexpr std::size_t pending_call_capacity = 4U;
constexpr std::size_t export_capacity = 4U;
constexpr std::size_t import_capacity = 4U;
constexpr std::size_t token_capacity = 64U;
constexpr std::size_t output_capacity = 128U;
constexpr std::size_t subscription_capacity = 2U;
constexpr std::size_t screen_url_capacity = 64U;
constexpr std::size_t m5sticks3_event_capacity = 8U;
constexpr std::size_t m5sticks3_event_notification_capacity = 8U;
constexpr std::size_t m5sticks3_event_subscription_capacity = 2U;

/*
 * These empty seams deliberately model only portable template-owned metadata.
 * Pulling the production M5StickS3 header into a host executable would also
 * pull ESP-IDF/FreeRTOS target types and make the profile impossible to run on
 * a developer machine. The injected operation objects are references inside
 * the backend, so their concrete target layout is not part of this sizeof.
 *
 * Every field emitted from these aliases is consequently named `HostAbi`.
 * The ESP32 map and runtime heap/task metrics remain authoritative for target
 * bytes; this host decomposition exists to catch accidental growth in the
 * portable queues, ledgers, and policy state on every ordinary test run.
 */
struct ProfileI2sOps {};
struct ProfileBoardOps {};
enum class ProfileGenerationFenceCommand : std::uint8_t {
  flushGeneration = 0U,
};
enum class ProfileLifecycleCommand : std::uint8_t {
  begin = 0U,
};

constexpr std::size_t m5sticks3_descriptor_count = 4U;
constexpr std::size_t m5sticks3_mono_samples_per_frame = 320U;
constexpr std::size_t m5sticks3_pcm_frame_bytes =
    m5sticks3_mono_samples_per_frame * sizeof(std::int16_t);
constexpr std::size_t m5sticks3_stereo_frame_bytes =
    m5sticks3_pcm_frame_bytes * 2U;
constexpr std::uint32_t m5sticks3_frame_duration_us = 20'000U;
constexpr std::size_t m5sticks3_pcm_capacity_ms = 640U;
constexpr std::size_t m5sticks3_pcm_slots_per_direction =
    m5sticks3_pcm_capacity_ms /
    (m5sticks3_frame_duration_us / 1'000U);

using ProfileDirectBackend =
    iterate::kit::platforms::EspIdfDirectI2sBackend<
        m5sticks3_descriptor_count,
        m5sticks3_stereo_frame_bytes,
        m5sticks3_frame_duration_us,
        ProfileI2sOps,
        ProfileBoardOps>;
using ProfileDirectOutput =
    iterate::kit::platforms::DirectI2sStereoOutput<
        m5sticks3_mono_samples_per_frame,
        m5sticks3_descriptor_count,
        ProfileDirectBackend>;
using ProfileRealtimePolicy =
    iterate::kit::platforms::RealtimePlayback<
        m5sticks3_mono_samples_per_frame,
        16'000U,
        m5sticks3_descriptor_count,
        200U,
        200U,
        2'000U>;
using ProfileGenerationFenceMailbox =
    iterate::kit::platforms::SingleOwnerCommandMailbox<
        ProfileGenerationFenceCommand,
        1'000U>;
using ProfileLifecycleMailbox =
    iterate::kit::platforms::SingleOwnerCommandMailbox<
        ProfileLifecycleCommand,
        1'000U>;
using ProfilePrebufferDeadline =
    iterate::kit::platforms::PartialPrebufferWakeDeadline<200U>;

/*
 * One fixed servo RPC keeps the workload deterministic and includes the real
 * JSON tokenization, pipeline dispatch, argument validation, driver callback,
 * result serialization, pull, and release path. 100,000 iterations amortize
 * timer granularity and one-time host process noise; the average still is not
 * a worst-case latency bound.
 */
constexpr char servo_call[] =
    R"json(["push",["pipeline",0,["servos","move"],[{"yawDegrees":12,"pitchDegrees":34,"speed":500}]]])json";

struct BenchmarkHardware {
  /*
   * Counting prevents the benchmark from reporting fast protocol churn that
   * never reached the device driver. The checksum also preserves argument
   * propagation as observable output, discouraging whole-work elimination by
   * an optimizer.
   */
  std::uint64_t move_count = 0U;
  std::int64_t checksum = 0;
};

struct CountingTransport {
  /*
   * Discard output bytes so terminal/pipe speed does not dominate the CPU
   * signal, but retain BEGIN/DATA/END state to reject malformed serialization.
   * byte_count measures Cap'n Web text payload emitted to this adapter, not
   * WebSocket/TLS wire bytes.
   */
  std::uint64_t byte_count = 0U;
  bool message_open = false;
};

iterate_kit_status request_playback_interruption(
    void *context, std::uint32_t *token) {
  if (context == nullptr || token == nullptr) return ITERATE_KIT_INVALID_ARGUMENT;
  *token = 1U;
  return ITERATE_KIT_OK;
}

iterate_kit_status poll_playback_interruption(
    void *context, std::uint32_t token) {
  if (context == nullptr || token != 1U) return ITERATE_KIT_INVALID_ARGUMENT;
  return ITERATE_KIT_OK;
}

iterate_kit_status render_png(
    void *, const char *, std::size_t) {
  /*
   * Hardware callbacks not involved in the servo workload are intentionally
   * constant-time. This profile measures portable protocol/capability overhead,
   * not guessed display, LED, camera, or metrics driver costs.
   */
  return ITERATE_KIT_OK;
}

iterate_kit_status change_sprite_set(
    void *, const char *, std::size_t) {
  return ITERATE_KIT_OK;
}

iterate_kit_status capture_screen(
    void *, iterate_kit_captured_screen *capture) {
  if (capture == nullptr) return ITERATE_KIT_INVALID_ARGUMENT;
  *capture = {};
  /* The servo benchmark never invokes screenshots; expose a valid driver. */
  return ITERATE_KIT_UNAVAILABLE;
}

iterate_kit_status move_servos(
    void *context,
    std::int32_t yaw_degrees,
    std::int32_t pitch_degrees,
    std::uint16_t speed) {
  auto &hardware = *static_cast<BenchmarkHardware *>(context);
  ++hardware.move_count;
  hardware.checksum += yaw_degrees + pitch_degrees + speed;
  return ITERATE_KIT_OK;
}

iterate_kit_status set_led(
    void *,
    std::uint8_t,
    std::uint8_t,
    std::uint8_t,
    std::uint8_t) {
  return ITERATE_KIT_OK;
}

iterate_kit_status fill_leds(
    void *, std::uint8_t, std::uint8_t, std::uint8_t) {
  return ITERATE_KIT_OK;
}

iterate_kit_status take_photo(void *, iterate_kit_photo *photo) {
  if (photo == nullptr) return ITERATE_KIT_INVALID_ARGUMENT;
  /*
   * Camera is not exercised, but a valid empty borrowed result keeps profile
   * composition honest without allocating a benchmark-only image.
   */
  *photo = {};
  return ITERATE_KIT_OK;
}

iterate_kit_status sample_metrics(
    void *, iterate_kit_metrics_sample *sample) {
  if (sample == nullptr) return ITERATE_KIT_INVALID_ARGUMENT;
  *sample = {};
  return ITERATE_KIT_OK;
}

capnweb_status count_text(
    void *context,
    capnweb_text_fragment_kind kind,
    const char *data,
    std::size_t length) {
  auto &transport = *static_cast<CountingTransport *>(context);
  /*
   * Validate the same fragment transaction contract as a real transport.
   * Merely adding `length` regardless of kind would let an encoder regression
   * produce impressive timing while emitting unusable message boundaries.
   */
  if (kind == CAPNWEB_TEXT_BEGIN) {
    if (transport.message_open || data != nullptr || length != 0U) {
      return CAPNWEB_E_TRANSPORT;
    }
    transport.message_open = true;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_DATA) {
    if (!transport.message_open ||
        (length > 0U && data == nullptr)) {
      return CAPNWEB_E_TRANSPORT;
    }
    transport.byte_count += length;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_END) {
    if (!transport.message_open || data != nullptr || length != 0U) {
      return CAPNWEB_E_TRANSPORT;
    }
    transport.message_open = false;
    return CAPNWEB_OK;
  }
  return CAPNWEB_E_TRANSPORT;
}

bool receive(
    capnweb_session *session,
    const char *message,
    std::size_t length) {
  /*
   * Treat any parser/dispatch status as benchmark failure. Skipping malformed
   * iterations would corrupt both throughput and driver-count evidence.
   */
  return capnweb_session_receive(session, message, length) == CAPNWEB_OK;
}

bool peak_resident_bytes(std::uint64_t *result) {
  /*
   * getrusage reports a process-lifetime high-water mark, including C++ runtime,
   * libc, code/data mappings as defined by the host OS, and setup before the
   * measured loop. macOS reports bytes while Linux reports KiB. Normalizing the
   * unit makes JSON comparable in shape, not directly comparable across OSes or
   * representative of ESP heap.
   */
  rusage usage{};
  if (result == nullptr || getrusage(RUSAGE_SELF, &usage) != 0) {
    return false;
  }
#if defined(__APPLE__)
  *result = static_cast<std::uint64_t>(usage.ru_maxrss);
#else
  *result = static_cast<std::uint64_t>(usage.ru_maxrss) * 1024U;
#endif
  return true;
}

}  // namespace

int main() {
  /*
   * These objects are the complete explicitly modelled protocol/profile
   * storage. They are stack-resident only because this is a short-lived host
   * process; the reported working-set arithmetic uses sizeof and does not claim
   * that an ESP task should place the same aggregate on its stack.
   */
  capnweb_session session{};
  capnweb_pending_call pending_calls[pending_call_capacity]{};
  capnweb_export exports[export_capacity]{};
  capnweb_import imports[import_capacity]{};
  capnweb_json_token tokens[token_capacity]{};
  char output_buffer[output_capacity]{};
  char screen_url_scratch[screen_url_capacity]{};
  char avatar_slug_scratch[32]{};
  iterate_kit_metrics_subscription subscriptions[subscription_capacity]{};
  CountingTransport transport{};
  BenchmarkHardware hardware{};
  iterate_kit_stackchan stackchan{};
  iterate_kit_aec_diagnostic_trace_capability aec_trace_capability{
    .initialized = 1U,
  };

  /*
   * Build the real StackChan composition with no-op hardware. `maximum_photo`
   * is one byte because photos are outside this servo workload; resource
   * accounting still includes the actual camera module state. A one-second
   * metrics period avoids incidental subscription work unless the protocol
   * explicitly creates one.
   */
  const iterate_kit_stackchan_options stackchan_options{
    {&hardware, render_png, nullptr},
    screen_url_scratch,
    sizeof(screen_url_scratch),
    {&hardware, change_sprite_set},
    avatar_slug_scratch,
    sizeof(avatar_slug_scratch),
    {&hardware, capture_screen},
    1U,
    {&hardware, move_servos},
    {&hardware, set_led, fill_leds},
    {&hardware, take_photo},
    1U,
    {
      &hardware,
      request_playback_interruption,
      poll_playback_interruption,
      50U,
    },
    {
      &session,
      {&hardware, sample_metrics},
      subscriptions,
      subscription_capacity,
      1'000U,
      false,
      false,
      false,
      false,
      nullptr,
      0U,
      nullptr,
    },
    &aec_trace_capability,
  };
  if (iterate_kit_stackchan_init(
          &stackchan, &stackchan_options) != CAPNWEB_OK) {
    std::cerr << "StackChan resource profile initialization failed\n";
    return 1;
  }

  /*
   * The session borrows every array until close. Initializing only after the
   * root profile exists resolves their mutual references while keeping all
   * ownership visible and bounded.
   */
  const capnweb_session_options session_options{
    iterate_kit_stackchan_capability(&stackchan),
    count_text,
    &transport,
    pending_calls,
    pending_call_capacity,
    exports,
    export_capacity,
    imports,
    import_capacity,
    tokens,
    token_capacity,
    output_buffer,
    output_capacity,
  };
  if (capnweb_session_init(&session, &session_options) != CAPNWEB_OK) {
    std::cerr << "Cap'n Web resource profile initialization failed\n";
    return 1;
  }

  char pull_message[32]{};
  char release_message[40]{};

  /*
   * Time the complete steady-state RPC lifecycle rather than only the driver
   * function: constructing numeric call IDs, parsing JSON, dispatching through
   * the pipeline, serializing, pulling, and releasing are all CPU work the
   * control plane imposes. Pull/release on every iteration is essential; if
   * references accumulated, a tiny table would fail early and an oversized
   * table would turn a leak into misleading benchmark progress.
   *
   * Formatting into fixed arrays avoids allocator noise and makes overflow a
   * classified test failure. The first iterations are retained instead of
   * hidden behind a warm-up phase; at this count their startup contribution is
   * negligible but remains part of the honest end-to-end cost.
   */
  const auto started = std::chrono::steady_clock::now();
  for (std::size_t index = 0U; index < iterations; ++index) {
    const auto call_id = static_cast<unsigned long long>(index + 1U);
    const int pull_length = std::snprintf(
        pull_message, sizeof(pull_message), "[\"pull\",%llu]", call_id);
    const int release_length = std::snprintf(
        release_message,
        sizeof(release_message),
        "[\"release\",%llu,1]",
        call_id);
    if (pull_length <= 0 ||
        static_cast<std::size_t>(pull_length) >= sizeof(pull_message) ||
        release_length <= 0 ||
        static_cast<std::size_t>(release_length) >= sizeof(release_message) ||
        !receive(&session, servo_call, sizeof(servo_call) - 1U) ||
        !receive(
            &session,
            pull_message,
            static_cast<std::size_t>(pull_length)) ||
        !receive(
            &session,
            release_message,
            static_cast<std::size_t>(release_length))) {
      std::cerr << "Cap'n Web servo benchmark failed at iteration "
                << index << '\n';
      return 1;
    }
  }
  const auto elapsed = std::chrono::steady_clock::now() - started;

  std::uint64_t host_peak_resident_bytes = 0U;
  if (!peak_resident_bytes(&host_peak_resident_bytes)) {
    std::cerr << "Could not read host peak resident memory\n";
    return 1;
  }

  /*
   * This sum is exact only for the named caller-owned objects and this ABI.
   * sizeof includes each object's internal padding, while the explicit sum does
   * not include transient call frames, executable code, libc, transport/TLS,
   * RTOS task stacks, or hardware-driver memory. Keeping the name
   * `protocolWorkingSetBytes` narrow prevents it from being reported as total
   * firmware RAM.
   */
  const std::size_t common_working_set_bytes =
      sizeof(session) +
      sizeof(pending_calls) +
      sizeof(exports) +
      sizeof(imports) +
      sizeof(tokens) +
      sizeof(output_buffer) +
      sizeof(screen_url_scratch) +
      sizeof(subscriptions);
  const std::size_t stackchan_profile_working_set_bytes =
      common_working_set_bytes + sizeof(stackchan);

  /*
   * M5StickS3 accounting is compile-time decomposition, not a live instance in
   * this benchmark. Capture, direct-I2S scratch, IDF DMA, the portable policy,
   * and lane payload reserve have different ownership and failure modes. A
   * single "audio bytes" total would make a future accidental FIFO look like a
   * harmless driver change, so the JSON keeps every class separate.
   */
  constexpr std::size_t m5sticks3_capture_frame_storage_bytes =
      iterate::kit::platforms::M5UnifiedHalfDuplex::
          captureFrameStorageBytes;
  constexpr std::size_t m5sticks3_platform_bytes =
      sizeof(iterate::kit::platforms::M5UnifiedHalfDuplex);
  static_assert(
      m5sticks3_platform_bytes >=
      m5sticks3_capture_frame_storage_bytes);
  constexpr std::size_t m5sticks3_platform_control_bytes =
      m5sticks3_platform_bytes -
      m5sticks3_capture_frame_storage_bytes;
  const std::size_t m5sticks3_control_plane_working_set_bytes =
      common_working_set_bytes +
      sizeof(iterate_kit_m5sticks3) +
      m5sticks3_platform_bytes +
      m5sticks3_event_capacity * sizeof(iterate_kit_device_event) +
      m5sticks3_event_notification_capacity *
          sizeof(iterate_kit_device_event_notification) +
      m5sticks3_event_subscription_capacity *
          sizeof(iterate_kit_device_event_subscription);

  constexpr std::size_t m5sticks3_direct_backend_host_abi_bytes =
      sizeof(ProfileDirectBackend);
  constexpr std::size_t m5sticks3_direct_output_host_abi_bytes =
      sizeof(ProfileDirectOutput);
  static_assert(
      m5sticks3_direct_output_host_abi_bytes >=
      m5sticks3_stereo_frame_bytes);
  constexpr std::size_t m5sticks3_direct_output_control_host_abi_bytes =
      m5sticks3_direct_output_host_abi_bytes -
      m5sticks3_stereo_frame_bytes;
  constexpr std::size_t m5sticks3_realtime_policy_host_abi_bytes =
      sizeof(ProfileRealtimePolicy);
  constexpr std::size_t
      m5sticks3_generation_fence_mailbox_host_abi_bytes =
          sizeof(ProfileGenerationFenceMailbox);
  constexpr std::size_t
      m5sticks3_lifecycle_mailbox_host_abi_bytes =
          sizeof(ProfileLifecycleMailbox);
  constexpr std::size_t
      m5sticks3_owner_timeout_counters_host_abi_bytes =
          2U * sizeof(
              iterate::kit::platforms::BoundedEventCounter);
  constexpr std::size_t m5sticks3_prebuffer_deadline_host_abi_bytes =
      sizeof(ProfilePrebufferDeadline);

  /*
   * IDF allocates one complete stereo frame per physical DMA descriptor when
   * the TX channel is created. It is not application-static storage and must
   * not be added to sizeof(output), but it is a real runtime RAM requirement.
   * Similarly, the 640 ms lane capacity is an outage/burst reserve in each
   * direction. This field reports PCM payload bytes only: slot metadata,
   * length arrays, and ring structs are target-ABI accounting in the map.
   */
  constexpr std::size_t m5sticks3_direct_dma_runtime_bytes =
      m5sticks3_descriptor_count *
      m5sticks3_stereo_frame_bytes;
  constexpr std::size_t m5sticks3_pcm_lane_payload_bytes =
      2U *
      m5sticks3_pcm_slots_per_direction *
      m5sticks3_pcm_frame_bytes;
  constexpr std::size_t m5sticks3_audio_task_stack_bytes = 8'192U;

  /*
   * Integer division reports an easy-to-gate average and intentionally does not
   * manufacture sub-nanosecond precision. Scheduler preemption and frequency
   * scaling remain in the host signal, so consumers should use this for broad
   * regression detection rather than a hard realtime SLO.
   */
  const auto elapsed_nanoseconds =
      std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed).count();
  const auto nanoseconds_per_servo_rpc =
      elapsed_nanoseconds / static_cast<std::int64_t>(iterations);

  const iterate_kit_poll_result close_result =
      iterate_kit_stackchan_close(&stackchan);
  /*
   * Teardown is outside the timed loop but still mandatory correctness work.
   * Close the profile before the session because profile modules may release
   * capabilities through that session. A close failure invalidates the run
   * even if the performance numbers look attractive.
   */
  capnweb_session_close(&session);
  if (close_result.status == ITERATE_KIT_POLL_CAPNWEB_ERROR) {
    std::cerr << "StackChan resource profile close failed\n";
    return 1;
  }

  /*
   * Emit one machine-readable record so CI can retain exact evidence alongside
   * compiled-size and device telemetry. Field names distinguish explicit
   * portable bytes from host RSS; `libraryHeapPolicy` refers only to the kit/C
   * library's caller-owned storage contract, not to iostream/libc internals in
   * this executable.
   */
  std::cout
      << "{\"libraryHeapPolicy\":\"no allocator dependency\""
      << ",\"iterations\":" << iterations
      << ",\"stackchanProfileBytes\":" << sizeof(stackchan)
      << ",\"m5sticks3ProfileBytes\":" << sizeof(iterate_kit_m5sticks3)
      << ",\"m5sticks3PlatformBytes\":"
      << m5sticks3_platform_bytes
      << ",\"m5sticks3CaptureFrameStorageBytes\":"
      << m5sticks3_capture_frame_storage_bytes
      << ",\"m5sticks3PlatformControlBytes\":"
      << m5sticks3_platform_control_bytes
      << ",\"m5sticks3DirectBackendHostAbiBytes\":"
      << m5sticks3_direct_backend_host_abi_bytes
      << ",\"m5sticks3DirectOutputHostAbiBytes\":"
      << m5sticks3_direct_output_host_abi_bytes
      << ",\"m5sticks3StereoScratchBytes\":"
      << m5sticks3_stereo_frame_bytes
      << ",\"m5sticks3DirectOutputControlHostAbiBytes\":"
      << m5sticks3_direct_output_control_host_abi_bytes
      << ",\"m5sticks3RealtimePolicyHostAbiBytes\":"
      << m5sticks3_realtime_policy_host_abi_bytes
      << ",\"m5sticks3GenerationFenceMailboxHostAbiBytes\":"
      << m5sticks3_generation_fence_mailbox_host_abi_bytes
      << ",\"m5sticks3LifecycleMailboxHostAbiBytes\":"
      << m5sticks3_lifecycle_mailbox_host_abi_bytes
      << ",\"m5sticks3OwnerTimeoutCountersHostAbiBytes\":"
      << m5sticks3_owner_timeout_counters_host_abi_bytes
      << ",\"m5sticks3PrebufferDeadlineHostAbiBytes\":"
      << m5sticks3_prebuffer_deadline_host_abi_bytes
      << ",\"m5sticks3DirectDmaRuntimeBytes\":"
      << m5sticks3_direct_dma_runtime_bytes
      << ",\"m5sticks3PcmLanePayloadBytes\":"
      << m5sticks3_pcm_lane_payload_bytes
      << ",\"m5sticks3AudioTaskStackBytes\":"
      << m5sticks3_audio_task_stack_bytes
      << ",\"m5sticks3EventStorageBytes\":"
      << m5sticks3_event_capacity * sizeof(iterate_kit_device_event)
      << ",\"m5sticks3EventNotificationStorageBytes\":"
      << m5sticks3_event_notification_capacity *
             sizeof(iterate_kit_device_event_notification)
      << ",\"m5sticks3EventSubscriptionStorageBytes\":"
      << m5sticks3_event_subscription_capacity *
             sizeof(iterate_kit_device_event_subscription)
      << ",\"m5sticks3CallbackBudgetBytes\":"
      << sizeof(iterate_kit_callback_budget)
      << ",\"metricSubscriptionBytes\":" << sizeof(subscriptions[0])
      << ",\"protocolWorkingSetBytes\":" << common_working_set_bytes
      << ",\"stackchanProfileWorkingSetBytes\":"
      << stackchan_profile_working_set_bytes
      << ",\"m5sticks3ControlPlaneWorkingSetBytes\":"
      << m5sticks3_control_plane_working_set_bytes
      << ",\"nanosecondsPerServoRpc\":" << nanoseconds_per_servo_rpc
      << ",\"hostPeakResidentBytes\":" << host_peak_resident_bytes
      << ",\"transportBytes\":" << transport.byte_count
      << ",\"driverCalls\":" << hardware.move_count
      << ",\"driverChecksum\":" << hardware.checksum
      << "}\n";

  /*
   * A timing sample is valid only if every requested RPC reached the driver.
   * byte_count and checksum remain diagnostic output, while call-count mismatch
   * makes the process fail rather than publish unexplained partial work.
   */
  return hardware.move_count == iterations ? 0 : 1;
}
