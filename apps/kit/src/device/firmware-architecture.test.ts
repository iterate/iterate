import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const firmwareDirectory = resolve(packageDirectory, "firmware");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".c", ".h", ".cpp", ".hpp"].includes(extname(path)) ? [path] : [];
  });
}

/*
 * Architecture boundaries constrain compiled dependencies, not engineering
 * prose. The firmware comments intentionally name rejected board-specific
 * designs so future changes preserve the reason for the portable boundary.
 * Scanning raw text made adding that explanation fail as if it were an actual
 * M5Unified include. Removing comments keeps the tripwire strict for code and
 * headers without incentivising less useful documentation.
 */
function sourceWithoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/[^\r\n]*/gu, "");
}

function sourceSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(
      `Expected firmware source section ${JSON.stringify(startMarker)} .. ${JSON.stringify(endMarker)}.`,
    );
  }
  return source.slice(start, end);
}

describe("firmware architecture boundaries", () => {
  test("the advertised C peer interoperability suite is present and runnable", () => {
    /*
     * The C implementation can agree with its own native tests while drifting
     * from the TypeScript runtime used by Iterate. Its README therefore makes
     * two load-bearing promises: supported behavior is exercised through the
     * real JS peer, and unsupported behavior is executed as a typed expected
     * failure rather than disappearing behind skipped tests. Pin the files
     * named by that contract so a vendor move or partial copy cannot leave
     * reassuring documentation pointing at a suite that no longer exists.
     */
    const interoperabilityDirectory = resolve(firmwareDirectory, "vendor/__tests__");

    expect(existsSync(resolve(interoperabilityDirectory, "c-interop.test.ts"))).toBe(true);
    expect(existsSync(resolve(interoperabilityDirectory, "c-interop-known-failures.ts"))).toBe(
      true,
    );
  });

  test("the shared core and capability modules have no board SDK dependencies", () => {
    const sharedDirectories = [
      resolve(firmwareDirectory, "components/core"),
      resolve(firmwareDirectory, "components/capabilities"),
    ];
    const forbidden = [
      /\bM5Unified\b/,
      /\bM5Stack\b/,
      /\besphome\b/i,
      /iterate\/kit\/devices\//,
      /iterate\/kit\/simulator\//,
    ];
    const violations = sharedDirectories.flatMap((directory) =>
      sourceFiles(directory).flatMap((path) => {
        const source = sourceWithoutComments(readFileSync(path, "utf8"));
        return forbidden
          .filter((pattern) => pattern.test(source))
          .map((pattern) => ({
            path: path.slice(firmwareDirectory.length + 1),
            pattern: pattern.source,
          }));
      }),
    );

    expect(violations).toEqual([]);
  });

  test("device profiles remain independent of platform SDK headers", () => {
    const violations = sourceFiles(resolve(firmwareDirectory, "devices")).flatMap((path) => {
      const source = sourceWithoutComments(readFileSync(path, "utf8"));
      return [/\bM5Unified\b/, /\besphome\b/i]
        .filter((pattern) => pattern.test(source))
        .map((pattern) => ({
          path: path.slice(firmwareDirectory.length + 1),
          pattern: pattern.source,
        }));
    });

    expect(violations).toEqual([]);
  });

  test("the M5StickS3 main loop routes physical and remote control through bounded owner-task queues", () => {
    const source = readFileSync(
      resolve(firmwareDirectory, "targets/m5sticks3/main/main.cpp"),
      "utf8",
    );

    expect(source).toContain("iterate_kit_spsc_ring_init");
    expect(source).toContain("iterate_kit_esp_idf_itx_transport_poll");
    expect(source).toContain("iterate_kit_m5sticks3_publish_push_to_talk");
    expect(source).toContain("ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL");
    expect(source).toContain("iterate_kit_device_event_type_name");
    expect(source).not.toContain("iterate_kit_m5sticks3_set_push_to_talk");
    expect(source).not.toContain("runMicrophoneSelfTest");
  });

  test("Cap'n Web control cannot absorb the independent binary PCM protocol", () => {
    const controlHeader = readFileSync(
      resolve(
        firmwareDirectory,
        "platforms/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_itx_transport.h",
      ),
      "utf8",
    );
    const controlSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_esp_idf/itx_transport.c"),
      "utf8",
    );
    const pcmHeader = readFileSync(
      resolve(firmwareDirectory, "components/core/include/iterate/kit/pcm_websocket.h"),
      "utf8",
    );

    expect(controlHeader).not.toContain("receive_binary_frame");
    expect(controlHeader).not.toContain("binary_context");
    expect(controlSource).not.toContain("INBOUND_LANE_BINARY");
    expect(controlSource).not.toContain("esp_websocket_client_send_bin");
    expect(pcmHeader).toContain('"iterate.kit.pcm.v1"');
    expect(pcmHeader).toContain("ITERATE_KIT_PCM_S16_LE");
  });

  test("the ESP control outbox has exactly one runtime consumer", () => {
    const controlSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_esp_idf/itx_transport.c"),
      "utf8",
    );
    const applicationPoll = sourceSection(
      controlSource,
      "iterate_kit_esp_idf_itx_transport_poll(",
      "iterate_kit_esp_idf_itx_transport_request_restart(",
    );
    const networkOwner = sourceSection(
      controlSource,
      "static void network_task(",
      "iterate_kit_esp_idf_itx_transport_prepare(",
    );

    /*
     * SPSC means one consumer for the ring's entire lifetime, including error
     * and shutdown paths. Letting the application poll "help" discard during a
     * failure can race the network task between read_acquire/read_release,
     * corrupting indices precisely while recovery is trying to establish a
     * clean generation. The application may observe emptiness and wake the
     * owner; only the network path may actually drain serialized messages.
     */
    expect(applicationPoll).not.toContain("discard_control_outbox(");
    expect(applicationPoll).not.toMatch(
      /spsc_ring_read_(?:acquire|release)\([^;]*control_outbox/su,
    );
    expect(networkOwner).toContain("discard_control_outbox(transport)");
  });

  test("the ESP PCM transport is a separate socket and never owns Wi-Fi", () => {
    const pcmTransportHeader = readFileSync(
      resolve(
        firmwareDirectory,
        "platforms/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_pcm_transport.h",
      ),
      "utf8",
    );
    const pcmTransportSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_esp_idf/pcm_transport.c"),
      "utf8",
    );
    const websocketConnectionSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_esp_idf/websocket_connection.c"),
      "utf8",
    );
    const conductorSource = readFileSync(
      resolve(firmwareDirectory, "components/core/src/pcm_uplink_conductor.c"),
      "utf8",
    );

    expect(pcmTransportHeader).toContain("struct iterate_kit_esp_idf_pcm_transport");
    expect(pcmTransportSource).toContain("iterate_kit_pcm_uplink_conductor_poll");
    expect(conductorSource).toContain("iterate_kit_websocket_tx_send");
    expect(pcmTransportSource).not.toContain("esp_websocket_client");
    expect(websocketConnectionSource).toContain("esp_transport_ws_init");
    expect(pcmTransportSource).toContain("iterate_kit_pcm_lane_receive_downlink");
    expect(pcmTransportSource).toContain("ITERATE_KIT_PCM_WEBSOCKET_SUBPROTOCOL");
    expect(pcmTransportSource).not.toMatch(/\besp_wifi_(?:init|start|stop|connect|disconnect)\b/u);
    expect(pcmTransportSource).not.toContain("esp_netif_create_default_wifi_sta");
    expect(websocketConnectionSource).not.toMatch(
      /\besp_wifi_(?:init|start|stop|connect|disconnect)\b/u,
    );
  });

  test("ESP WebSocket diagnostics are atomic across the network and metrics tasks", () => {
    /*
     * The socket owner records every read/write outcome while the main task
     * takes the public one-second snapshot. ESP32 word alignment does not make
     * a plain C read racing a write legal: the optimizer is allowed to invent
     * observations or lose updates. The native atomic stress test proves the
     * primitive; this seam test makes sure every cross-task WebSocket counter
     * actually uses it on both sides of that ownership boundary.
     */
    const source = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_esp_idf/websocket_connection.c"),
      "utf8",
    ).replaceAll(/\s+/gu, " ");
    const counters = [
      "raw_write_calls",
      "raw_write_partial",
      "raw_write_deferrals",
      "raw_write_failures",
      "receive_calls",
      "receive_chunks",
      "receive_dropped",
      "pings_received",
      "pongs_received",
      "control_backpressure",
    ];

    expect(source).toContain('#include "iterate/kit/atomic.h"');
    for (const counter of counters) {
      expect(source).toContain(
        `iterate_kit_atomic_saturating_increment_relaxed_u32( &connection->${counter})`,
      );
      expect(source).toContain(`iterate_kit_atomic_load_relaxed_u32( &connection->${counter})`);
    }
  });

  test("captured PCM wakes its consumer instead of waiting for a polling tick", () => {
    const targetSource = readFileSync(
      resolve(firmwareDirectory, "targets/m5sticks3/main/main.cpp"),
      "utf8",
    );
    const pcmTransportHeader = readFileSync(
      resolve(
        firmwareDirectory,
        "platforms/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_pcm_transport.h",
      ),
      "utf8",
    );

    expect(pcmTransportHeader).toContain("iterate_kit_esp_idf_pcm_transport_notify_uplink");
    expect(targetSource).toMatch(
      /iterate_kit_pcm_lane_submit_uplink[\s\S]*iterate_kit_esp_idf_pcm_transport_notify_uplink/u,
    );
  });

  test("a newly connected PCM socket drops microphone audio captured during its handshake", () => {
    const pcmTransportSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_esp_idf/pcm_transport.c"),
      "utf8",
    );
    const markConnected = pcmTransportSource.slice(
      pcmTransportSource.indexOf("static bool mark_socket_connected("),
      pcmTransportSource.indexOf("static void protocol_failure("),
    );

    /*
     * Socket open can block for DNS/TCP/TLS/upgrade while the microphone keeps
     * publishing. The portable generation transition, rather than an ESP-only
     * discard call, must purge that entire epoch before readiness becomes
     * visible. This ordering is what prevents a long-held PTT utterance from
     * replaying its handshake-era prefix after the network finally connects.
     */
    expect(pcmTransportSource).toMatch(
      /iterate_kit_esp_idf_websocket_connection_open[\s\S]*mark_socket_connected\(transport\)/u,
    );
    expect(markConnected).toMatch(
      /iterate_kit_pcm_uplink_conductor_begin_generation[\s\S]*socket_connected,\s*1U/u,
    );
  });

  test("local PCM socket acceptance remains bounded until the peer proves ordered delivery", () => {
    /*
     * ESP-IDF can accept bytes into TLS/lwIP while the radio is stalled. Merely
     * checking the application ring would let those old frames escape after
     * recovery. This architecture seam ensures the real platform—not only the
     * portable unit fixture—feeds sender acceptance events into the peer guard,
     * services pongs, and resets proof state with every socket generation.
     */
    const pcmTransportHeader = readFileSync(
      resolve(
        firmwareDirectory,
        "platforms/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_pcm_transport.h",
      ),
      "utf8",
    );
    const pcmTransportSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_esp_idf/pcm_transport.c"),
      "utf8",
    );
    const conductorHeader = readFileSync(
      resolve(firmwareDirectory, "components/core/include/iterate/kit/pcm_uplink_conductor.h"),
      "utf8",
    );
    const conductorSource = readFileSync(
      resolve(firmwareDirectory, "components/core/src/pcm_uplink_conductor.c"),
      "utf8",
    );
    /*
     * Return type is part of the conductor API and may legitimately evolve.
     * The old `static void` marker silently produced an empty slice when the
     * function began returning its scheduling verdict, obscuring the actual
     * invariant under test. Anchor on the function name and its next stable
     * owner-task boundary instead.
     */
    const sendUplink = sourceSection(
      pcmTransportSource,
      "send_uplink(",
      "static void stop_websocket(",
    );

    expect(pcmTransportHeader).toContain('#include "iterate/kit/pcm_uplink_conductor.h"');
    expect(pcmTransportHeader).toMatch(/struct iterate_kit_pcm_uplink_conductor\s+uplink/u);
    expect(conductorHeader).toContain('#include "iterate/kit/pcm_peer_delivery_guard.h"');
    expect(conductorHeader).toMatch(/struct iterate_kit_pcm_peer_delivery_guard\s+peer_delivery/u);
    expect(pcmTransportSource).toMatch(
      /ITERATE_KIT_WEBSOCKET_PONG[\s\S]*iterate_kit_pcm_uplink_conductor_receive_pong/u,
    );
    expect(sendUplink).toContain("iterate_kit_pcm_uplink_conductor_poll");
    expect(conductorSource).toMatch(
      /iterate_kit_pcm_peer_delivery_guard_poll[\s\S]*iterate_kit_pcm_uplink_sender_poll/u,
    );
    expect(conductorSource).toContain("struct iterate_kit_pcm_uplink_sender_event event");
    expect(conductorSource).toContain("iterate_kit_pcm_peer_delivery_guard_record_accept");
  });

  test("received PCM wakes the playback owner instead of waiting for a polling tick", () => {
    const targetSource = readFileSync(
      resolve(firmwareDirectory, "targets/m5sticks3/main/main.cpp"),
      "utf8",
    );
    const pcmTransportHeader = readFileSync(
      resolve(
        firmwareDirectory,
        "platforms/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_pcm_transport.h",
      ),
      "utf8",
    );
    const pcmTransportSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_esp_idf/pcm_transport.c"),
      "utf8",
    );

    expect(pcmTransportHeader).toContain("downlink_ready");
    expect(pcmTransportSource).toMatch(
      /iterate_kit_pcm_lane_receive_downlink[\s\S]*status != ITERATE_KIT_OK[\s\S]*return false;[\s\S]*downlink_ready/u,
    );
    expect(targetSource).toContain("downlinkReady");
    expect(targetSource).toMatch(
      /pollPlayback\(\)[\s\S]*ulTaskNotifyTake\(pdFALSE, mainLoopDelayTicks\)/u,
    );
    expect(targetSource).not.toContain("vTaskDelay(mainLoopDelayTicks)");
  });

  test("the Stick PCM rings express measured stall coverage rather than arbitrary frame counts", () => {
    const targetSource = readFileSync(
      resolve(firmwareDirectory, "targets/m5sticks3/main/main.cpp"),
      "utf8",
    );

    expect(targetSource).toContain("pcmUplinkCapacityMilliseconds = 640U");
    expect(targetSource).toContain("pcmDownlinkCapacityMilliseconds = 640U");
    expect(targetSource).toMatch(
      /pcmUplinkSlotCount\s*=\s*pcmUplinkCapacityMilliseconds\s*\/\s*pcmFrameDurationMilliseconds/u,
    );
    expect(targetSource).toMatch(
      /pcmDownlinkSlotCount\s*=\s*pcmDownlinkCapacityMilliseconds\s*\/\s*pcmFrameDurationMilliseconds/u,
    );
  });

  test("the Cap'n Web owner cannot run on the realtime audio core", () => {
    const controlSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_esp_idf/itx_transport.c"),
      "utf8",
    );
    const audioHeader = readFileSync(
      resolve(
        firmwareDirectory,
        "platforms/iterate_m5unified/include/iterate/kit/platforms/m5sticks3_direct_audio.hpp",
      ),
      "utf8",
    );

    /*
     * A capability callback can trigger TLS writes, reconnect bookkeeping, and
     * logging while the speaker has only one 20 ms descriptor deadline. The
     * old source pinned both owners to core 1 even though its scheduling
     * comment promised stable audio headroom. Priorities reduce contention but
     * do not prevent an interrupt-disabled or non-preemptible control section
     * from delaying I2S. Keep control/network work on core 0 and the direct
     * audio owner on core 1; this is a placement invariant, not a performance
     * suggestion that a future refactor may silently undo.
     */
    expect(controlSource).toContain("NETWORK_TASK_CORE = 0");
    expect(audioHeader).toContain("realtimeTaskCore = 1");
    expect(controlSource).not.toContain("NETWORK_TASK_CORE = CONFIG_FREERTOS_NUMBER_OF_CORES - 1");
  });

  test("the control WebSocket cannot opt into concurrent access to one TLS context", () => {
    const mainSdkConfig = readFileSync(
      resolve(firmwareDirectory, "targets/m5sticks3/sdkconfig.defaults"),
      "utf8",
    );

    /*
     * ESP WebSocket's separate TX lock allows its sender and receive task to
     * enter the same mbedTLS context concurrently. The Stick does not enable
     * mbedTLS C threading, so this is undefined ownership rather than useful
     * full duplex. The PCM lane already has its own socket; capability traffic
     * may serialize behind the library's default recursive lock and must never
     * purchase responsiveness by racing TLS internals.
     */
    expect(mainSdkConfig).toContain("# CONFIG_ESP_WS_CLIENT_SEPARATE_TX_LOCK is not set");
    expect(mainSdkConfig).not.toContain("CONFIG_ESP_WS_CLIENT_SEPARATE_TX_LOCK=y");
  });

  test("cycle-accounted firmware tasks cannot migrate between CPU counters", () => {
    const controlSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_esp_idf/itx_transport.c"),
      "utf8",
    );
    const mainSdkConfig = readFileSync(
      resolve(firmwareDirectory, "targets/m5sticks3/sdkconfig.defaults"),
      "utf8",
    );

    expect(controlSource).toContain("xTaskCreateStaticPinnedToCore");
    expect(controlSource).toContain("NETWORK_TASK_CORE);");
    expect(mainSdkConfig).toContain("CONFIG_ESP_MAIN_TASK_AFFINITY_CPU0=y");
  });

  test("the direct M5 audio owner exists before any PCM transport can admit downlink", () => {
    const platformSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_m5unified/m5unified.cpp"),
      "utf8",
    );
    const targetSource = readFileSync(
      resolve(firmwareDirectory, "targets/m5sticks3/main/main.cpp"),
      "utf8",
    );
    const bindFunction = sourceSection(
      platformSource,
      "M5UnifiedHalfDuplex::bindPcmLane(",
      "M5UnifiedHalfDuplex::pollPlayback()",
    );
    const stopCaptureFunction = sourceSection(
      platformSource,
      "M5UnifiedHalfDuplex::stopCapture(",
      "M5UnifiedHalfDuplex::stopPlayback(",
    );

    /*
     * M5Unified's old prepare(M5.Speaker) call also started its mixer task and
     * retained another audio queue. The direct design instead creates the
     * priority-19 owner while binding the already-initialized lane. Pin both
     * sides of that ordering: the owner is live before either socket starts,
     * and microphone release hands shared clocks back to that same owner.
     */
    expect(bindFunction).toContain("audioOwner_.begin(lane)");
    expect(targetSource.indexOf("initialiseRings(runtime)")).toBeLessThan(
      targetSource.indexOf("iterate_kit_esp_idf_itx_transport_start("),
    );
    expect(targetSource.indexOf("initialiseRings(runtime)")).toBeLessThan(
      targetSource.indexOf("iterate_kit_esp_idf_pcm_transport_start("),
    );
    expect(stopCaptureFunction).toContain("audioOwner_.resumeAfterCapture()");
  });

  test("generation fences cannot be overwritten by lifecycle or metrics commands", () => {
    const ownerHeader = readFileSync(
      resolve(
        firmwareDirectory,
        "platforms/iterate_m5unified/include/iterate/kit/platforms/m5sticks3_direct_audio.hpp",
      ),
      "utf8",
    );
    const ownerSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_m5unified/m5sticks3_direct_audio.cpp"),
      "utf8",
    );
    const flushFunction = sourceSection(
      ownerSource,
      "M5StickS3DirectAudioOwner::flushGeneration(",
      "M5StickS3DirectAudioOwner::suspendForCapture()",
    );
    const ownerLoop = sourceSection(
      ownerSource,
      "void M5StickS3DirectAudioOwner::taskLoop()",
      "M5StickS3DirectAudioOwner::executeGenerationFenceCommand(",
    );
    const boundedLifecycle = sourceSection(
      ownerSource,
      "M5StickS3DirectAudioOwner::runBoundedCommand(",
      "M5StickS3DirectAudioOwner::stopAndDiscard()",
    );

    /*
     * A completed reconnect fence may remain unconsumed when the 1 Hz metrics
     * sample arrives. One shared mailbox lets the different snapshot key erase
     * that completion and causes the next fence poll to tear I2S down twice.
     * Separate enum types plus separate storage make cross-lane publication a
     * compile-time error; pin every production call site so the host mailbox
     * interleaving regression cannot become a disconnected toy.
     */
    expect(ownerHeader).toContain("GenerationFenceMailbox generationFenceMailbox_{}");
    expect(ownerHeader).toContain("LifecycleMailbox lifecycleMailbox_{}");
    expect(ownerHeader).not.toContain("CommandMailbox commandMailbox_");
    expect(flushFunction).toContain("generationFenceMailbox_.request(");
    expect(flushFunction).toContain("generationFenceAcknowledgementTimeouts_.record()");
    expect(boundedLifecycle).toContain("lifecycleMailbox_.request(");
    expect(boundedLifecycle).toContain("lifecycleAcknowledgementTimeouts_.record()");
    expect(ownerLoop).toContain("generationFenceMailbox_.take(");
    expect(ownerLoop).toContain("lifecycleMailbox_.take(");

    /*
     * ESP-IDF publishes its private completed-buffer pointer before yielding
     * from the EOF ISR. A retry loop here therefore adds only priority
     * inversion and a possible 10 ms tick-shaped jiggle.
     */
    expect(ownerLoop).not.toContain("taskYIELD()");
    expect(ownerLoop).not.toContain("vTaskDelay(");
    expect(ownerLoop).not.toContain("retryPending");
  });

  test("M5 initialization primes CPU accounting before the first Cap'n Web sample", () => {
    const platformSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_m5unified/m5unified.cpp"),
      "utf8",
    );
    const beginFunction = platformSource.slice(
      platformSource.indexOf("bool M5UnifiedHalfDuplex::begin()"),
      platformSource.indexOf("void M5UnifiedHalfDuplex::update()"),
    );

    expect(beginFunction).toContain("iterate_kit_cpu_usage_meter_init");
    expect(beginFunction).toContain("iterate_kit_cpu_usage_meter_sample");
  });

  test("the M5 audio owner performs no serial or display I/O in its steady-state loop", () => {
    const targetSource = readFileSync(
      resolve(firmwareDirectory, "targets/m5sticks3/main/main.cpp"),
      "utf8",
    );
    const steadyStateLoop = targetSource.slice(targetSource.indexOf("for (;;) {"));

    expect(targetSource).toContain("sampleRuntimeMetrics");
    expect(steadyStateLoop).not.toContain("reportMetrics(runtime)");
    expect(steadyStateLoop).not.toContain("runtime.platform.showStatus(");
  });

  test("the default TypeScript suite executes assertion-enabled native tests", () => {
    const simulatorSuite = readFileSync(
      resolve(packageDirectory, "src/device/stackchan-simulator.e2e.test.ts"),
      "utf8",
    );
    const hostCmake = readFileSync(resolve(firmwareDirectory, "CMakeLists.txt"), "utf8");

    expect(hostCmake).toContain("add_compile_options(-UNDEBUG)");
    expect(simulatorSuite).toContain('["--build", buildDirectory, "--target", "test"]');
  });
});
