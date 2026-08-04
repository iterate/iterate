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

  test("the M5StickS3 control mailboxes cover one maximum owner-loop burst", () => {
    /*
     * The physical 20 Hz diagnostics run exposed a profile-level deadlock:
     * the shared callback budget can synchronously emit push+pull for each of
     * two admitted calls, then the same owner loop can process four inbound pulls
     * whose resolutions also need outbox slots. With only four slots, a valid
     * getDiagnostics pull arrived while the metrics fanout occupied the whole
     * ring; Cap'n Web correctly treated its failed send as terminal, but the
     * remote promise had no response to settle.
     *
     * The matching inbox bound was learned from the next physical failure.
     * Two callback calls can each return resolve+release while
     * one bounded remote call contributes push+pull and the preceding call's
     * release. Those seven messages are causally valid even though the harness
     * permits only one diagnostics call in flight. A four-slot inbox therefore
     * replaced a healthy generation after 51.7 seconds; that was burst loss,
     * not evidence that the peer had created unbounded concurrent work.
     *
     * These are burst reserves, not permission to accumulate control history.
     * The sole network consumer remains nonblocking and a delay beyond one
     * profiled producer pass still becomes an explicit generation failure.
     */
    const source = readFileSync(
      resolve(firmwareDirectory, "targets/m5sticks3/main/main.cpp"),
      "utf8",
    );
    const constant = (name: string) => {
      const match = new RegExp(`constexpr std::size_t ${name} =\\s*(\\d+)U;`, "u").exec(source);
      if (!match) throw new Error(`Could not read M5StickS3 profile constant ${name}.`);
      return Number(match[1]);
    };
    const controlInboxSlotCount = constant("controlInboxSlotCount");
    const controlOutboxSlotCount = constant("controlOutboxSlotCount");
    const controlMessagesPerPoll = constant("controlMessagesPerPoll");
    const controlRemoteCallLifecycleMessages = constant("controlRemoteCallLifecycleMessages");
    const callbackConcurrency = constant("callbackConcurrency");

    expect(controlInboxSlotCount).toBeGreaterThanOrEqual(
      callbackConcurrency * 2 + controlRemoteCallLifecycleMessages,
    );
    expect(controlOutboxSlotCount).toBeGreaterThanOrEqual(
      callbackConcurrency * 2 + controlMessagesPerPoll,
    );
  });

  test("the M5StickS3 control slots neither inherit another target's width nor consume TLS SRAM", () => {
    /*
     * The Waveshare VoiceLab path needs an 8 KiB outbound Cap'n Web message for
     * eight-frame microphone appends. The Stick sends microphone audio over
     * its separate binary /pcm socket, so neither direction can produce that
     * shape. Reusing the transport-wide maximum for both eight-slot rings added
     * 64 KiB of permanent internal SRAM, first breaking the link and then
     * starving the second TLS socket at runtime. Pin this target's actual 4 KiB
     * control envelope and keep these non-realtime mailboxes in PSRAM without
     * weakening any PCM ring or the Waveshare batch. The PCM ring deliberately
     * remains inside Runtime/internal SRAM: only control traffic may pay PSRAM
     * latency so audio still makes progress while flash/cache access stalls.
     */
    const source = readFileSync(
      resolve(firmwareDirectory, "targets/m5sticks3/main/main.cpp"),
      "utf8",
    );
    const sdkconfigDefaults = readFileSync(
      resolve(firmwareDirectory, "targets/m5sticks3/sdkconfig.defaults"),
      "utf8",
    );
    const constant = (name: string) => {
      const match = new RegExp(`constexpr std::size_t ${name} =\\s*(\\d+)U;`, "u").exec(source);
      if (!match) throw new Error(`Could not read M5StickS3 profile constant ${name}.`);
      return Number(match[1]);
    };

    const inboxBytes = constant("controlInboxSlotCapacity");
    const outboxBytes = constant("controlOutboxSlotCapacity");
    expect(inboxBytes).toBe(4096);
    expect(outboxBytes).toBe(4096);
    expect(source).toMatch(
      /EXT_RAM_BSS_ATTR static std::uint8_t\s+controlInboxStorage\[controlInboxSlotCount\]\s*\[controlInboxSlotCapacity\]/u,
    );
    expect(source).toMatch(
      /EXT_RAM_BSS_ATTR static std::uint8_t\s+controlOutboxStorage\[controlOutboxSlotCount\]\s*\[controlOutboxSlotCapacity\]/u,
    );
    expect(sdkconfigDefaults).toContain("CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y");

    const runtime = sourceSection(source, "struct Runtime {", "\n};\n\nRuntime runtime;");
    expect(runtime).not.toContain("controlInboxStorage");
    expect(runtime).not.toContain("controlOutboxStorage");
    expect(runtime).toContain("pcmUplinkStorage");
    expect(runtime).toContain("pcmDownlinkStorage");
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

  test("the Cap'n Web owner uses the bounded taskless WebSocket transport", () => {
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

    /*
     * A physical station outage proved that the managed ESP WebSocket client
     * can make our supposedly bounded recovery path wait forever. Its stop()
     * joins a private worker with portMAX_DELAY; after Wi-Fi and ICMP recovered,
     * neither capability nor PCM remounted because the control owner remained
     * inside that hidden join. A host fake that returns from stop immediately
     * cannot reproduce that ownership failure.
     *
     * The control plane already has one explicit static network owner, and PCM
     * already proves the lower esp_transport_ws wrapper. Reusing that taskless
     * connection removes the second owner, the unbounded join, and one hidden
     * task stack. This source-level tripwire exists because "stop is bounded"
     * cannot be established by a timing test against a cooperative fake.
     */
    expect(controlHeader).toContain(
      '#include "iterate/kit/platforms/esp_idf_websocket_connection.h"',
    );
    expect(controlHeader).not.toContain("esp_websocket_client");
    expect(controlSource).toContain("iterate_kit_esp_idf_websocket_connection_open");
    expect(controlSource).toContain("iterate_kit_esp_idf_websocket_connection_receive");
    expect(controlSource).not.toContain("esp_websocket_client");
    expect(controlSource).not.toContain("WEBSOCKET_TASK_STACK_BYTES");
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

  test("an intentional generation flush is not reported as a downlink fault", () => {
    const targetSource = readFileSync(
      resolve(firmwareDirectory, "targets/m5sticks3/main/main.cpp"),
      "utf8",
    );
    const sample = sourceSection(
      targetSource,
      "iterate_kit_status sampleRuntimeMetrics(",
      "#undef COPY_PLAYBACK_METRIC",
    );

    /*
     * Button barge-in deliberately destroys the old assistant generation.
     * `generationFramesFlushed` already retains that exact expected outcome;
     * also folding lane-generation discards into `downlink.dropped` makes the
     * same healthy interruption look like an unexplained transport fault.
     * Keep fault telemetry for producer backpressure and the explicit flush
     * ledger for obsolete conversational state.
     */
    expect(sample).toContain(
      "sample->audio.downlink.dropped = saturatingMetricValue(pcm.lane.downlink.producer_backpressure);",
    );
    expect(sample).not.toMatch(/audio\.downlink\.dropped[\s\S]{0,160}downlink_frames_discarded/u);
    expect(sample).toContain("playback.generationFramesFlushed");
  });

  test("PCM arriving during half-duplex capture remains in the interruption ledger", () => {
    const ownerSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_m5unified/m5sticks3_direct_audio.cpp"),
      "utf8",
    );
    const ownerHeader = readFileSync(
      resolve(
        firmwareDirectory,
        "platforms/iterate_m5unified/include/iterate/kit/platforms/m5sticks3_direct_audio.hpp",
      ),
      "utf8",
    );
    const taskLoop = sourceSection(
      ownerSource,
      "void M5StickS3DirectAudioOwner::taskLoop()",
      "M5StickS3DirectAudioOwner::executeGenerationFenceCommand(",
    );
    const generationFence = sourceSection(
      ownerSource,
      "M5StickS3DirectAudioOwner::executeGenerationFenceCommand(",
      "M5StickS3DirectAudioOwner::executeLifecycleCommand(",
    );
    const snapshot = sourceSection(
      ownerSource,
      "M5StickS3DirectAudioOwner::executeLifecycleCommand(",
      "M5StickS3DirectAudioOwner::runBoundedCommand(",
    );

    /*
     * The device flushes first and only then can its physical PTT event reach
     * userspace to cancel Grok. Frames crossing that causal gap are expected
     * obsolete speech: the priority owner continuously discards them, but the
     * same frames still belong in exact played-or-flushed conservation. A raw
     * lane counter cannot be merged later because explicit stop/generation
     * fences already include their lane frames and would be double-counted.
     */
    expect(ownerHeader).toContain("BoundedEventCounter suspendedFramesFlushed_{}");
    expect(taskLoop).toMatch(
      /iterate_kit_pcm_lane_discard_downlink\([\s\S]*suspendedFramesFlushed_\.add\(discarded\)/u,
    );
    expect(generationFence).toMatch(
      /iterate_kit_pcm_lane_discard_downlink\([\s\S]*suspendedFramesFlushed_\.add\(discarded\)/u,
    );
    expect(snapshot).toContain("suspendedFramesFlushed_.value()");
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

  test("PCM freshness never depends on hop-level PONG delivery credit", () => {
    /*
     * A previous design stopped accepting fresh microphone frames after eight
     * local sends until a client PING received a PONG. Captun terminates that
     * control exchange at its public gateway, so the PONG proved neither that
     * this userspace bridge nor Grok had received audio. Long-held PTT could
     * therefore stall behind an acknowledgement that had no end-to-end
     * meaning. Freshness is bounded by ring capacity, frame age, write-progress
     * deadlines, and generation purge instead. RFC 6455 still requires the
     * device to answer a server PING, but that reply must alter no PCM policy.
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
    const websocketConnectionSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_esp_idf/websocket_connection.c"),
      "utf8",
    );
    const websocketTxSource = readFileSync(
      resolve(firmwareDirectory, "components/core/src/websocket_tx.c"),
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
    expect(sendUplink).toContain("iterate_kit_pcm_uplink_conductor_poll");
    expect(conductorSource).toMatch(
      /iterate_kit_websocket_tx_poll_control[\s\S]*iterate_kit_pcm_uplink_sender_poll/u,
    );
    expect(conductorSource).toContain("struct iterate_kit_pcm_uplink_sender_event event");
    expect(
      existsSync(resolve(firmwareDirectory, "components/core/src/pcm_peer_delivery_guard.c")),
    ).toBe(false);
    expect(sourceWithoutComments(conductorHeader)).not.toContain("peer_delivery");
    expect(sourceWithoutComments(pcmTransportSource)).not.toContain(
      "iterate_kit_pcm_uplink_conductor_receive_pong",
    );
    expect(sourceWithoutComments(websocketTxSource)).not.toContain("ITERATE_KIT_WEBSOCKET_PING");
    expect(websocketConnectionSource).toMatch(
      /ITERATE_KIT_WEBSOCKET_PING[\s\S]*iterate_kit_websocket_tx_queue_control\([\s\S]*ITERATE_KIT_WEBSOCKET_PONG/u,
    );
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
    /*
     * ESP-IDF 5.4 does not expose this option for the component version in the
     * Stick build. Writing an explicit "# ... is not set" line therefore
     * produces an unknown-symbol warning rather than strengthening the
     * contract. The useful invariant is simply that nobody opts in if a later
     * IDF version introduces the option.
     */
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
    expect(bindFunction).toMatch(
      /audioOwner_\.begin\(\s*lane,\s*itemReleased,\s*itemReleasedContext\s*\)/u,
    );
    expect(targetSource.indexOf("initialiseRings(runtime)")).toBeLessThan(
      targetSource.indexOf("iterate_kit_esp_idf_itx_transport_start("),
    );
    expect(targetSource.indexOf("initialiseRings(runtime)")).toBeLessThan(
      targetSource.indexOf("iterate_kit_esp_idf_pcm_session_poll("),
    );
    expect(stopCaptureFunction).toContain("audioOwner_.resumeAfterCapture()");
  });

  test("the Stick direct path limits speaker power at the codec rather than per PCM frame", () => {
    const ownerSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_m5unified/m5sticks3_direct_audio.cpp"),
      "utf8",
    );
    const configureCodecFunction = sourceSection(
      ownerSource,
      "M5StickS3AudioBoardOps::configureCodec()",
      "M5StickS3DirectAudioOwner::begin(",
    );

    /*
     * Direct I2S deliberately bypasses M5Unified's mixer and its default
     * software attenuation. Leaving the copied ES8311 register at 0 dB made a
     * 75%-scale deterministic tone trip the physical Stick's brownout
     * detector after 43 frames. Attenuating once in the codec keeps arbitrary
     * provider PCM inside the board's power envelope without spending one
     * multiply, branch, scratch buffer, or extra cycle on every audio sample.
     *
     * Espressif documents register 0x32 as half-decibel steps with 0xBF equal
     * to 0 dB. Pin the named 36-step (-18 dB) policy and its use in the actual
     * register sequence. A future volume control may make this configurable,
     * but it must retain a board-safe ceiling rather than restoring raw 0 dB.
     */
    expect(ownerSource).toContain("es8311SafeDacAttenuationHalfDbSteps = 36U");
    expect(ownerSource).toMatch(
      /es8311SafeDacVolume\s*=\s*es8311ZeroDbVolume\s*-\s*es8311SafeDacAttenuationHalfDbSteps/u,
    );
    expect(configureCodecFunction).toContain("{0x32U, es8311SafeDacVolume}");
    expect(configureCodecFunction).not.toContain("{0x32U, 0xbfU}");
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

  test("the M5StickS3 display selects exact public avatar slugs", () => {
    const platformSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_m5unified/m5unified.cpp"),
      "utf8",
    );

    /*
     * The initial red/green proof exposed an M5GFX colour-width trap but was
     * not a useful product abstraction. A sprite set is a stable exact slug;
     * selecting it through the shared registry keeps atlas order private and
     * makes the same capability meaningful on Stick and StackChan.
     */
    expect(platformSource).toContain("face_avatar_registry_select_slug");
    expect(platformSource).toContain("M5UnifiedHalfDuplex::changeSpriteSet");
    expect(platformSource).not.toContain("m5StickS3PhysicalRed");
    expect(platformSource).not.toContain("m5StickS3PhysicalGreen");
  });

  test("the M5StickS3 screen explains the physical call controls and follows real lifecycle state", () => {
    const platformSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_m5unified/m5unified.cpp"),
      "utf8",
    );
    const targetSource = readFileSync(
      resolve(firmwareDirectory, "targets/m5sticks3/main/main.cpp"),
      "utf8",
    );

    /*
     * A successful remote proof is not a usable product if the person holding
     * the Stick cannot discover its two-button call model. The display must be
     * driven from reconciled device/socket/audio state, not merely from button
     * edges: an optimistic "connected" label during TLS failure would be more
     * misleading than no UI. A sprite change repaints through the same retained
     * view, so a Grok tool call cannot erase the status rail.
     */
    expect(platformSource).toContain('"TOP"');
    expect(platformSource).toContain('"FRN"');
    expect(platformSource).toContain('"MIC"');
    expect(platformSource).toContain('"AI"');
    expect(platformSource).toContain("renderCallUi(true)");
    /*
     * A rendered screen is not evidence that later lifecycle transitions can
     * repaint it. The first implementation changed callUiState_ and then
     * invoked the ordinary renderer while its "already drawn" latch remained
     * set, permanently leaving the person on the BOOTING screen even though
     * the control and PCM sockets were alive. A transition must explicitly
     * dirty the retained view before asking the allocation-free renderer to
     * reconcile it.
     */
    expect(platformSource).toMatch(
      /callUiState_ = state;[\s\S]*?callUiDrawn_ = false;[\s\S]*?renderCallUi\(false\);/,
    );
    expect(targetSource).toContain("selectCallUiState(runtime)");
    expect(targetSource).toContain("iterate_kit_esp_idf_pcm_session_transport_ready(");
    expect(targetSource).toContain("iterate_kit_m5sticks3_is_capturing(&state.device)");
    expect(targetSource).toContain("RealtimePlaybackState::playing");
  });

  test("screen targets render one shared dozing state only outside a conversation", () => {
    const stickSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_m5unified/m5unified.cpp"),
      "utf8",
    );
    const stackChanSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_stackchan_avatar/stackchan_avatar.c"),
      "utf8",
    );

    /*
     * Closed-eye controls were once target-local and had no pixel oracle, so
     * the physical StackChan could still look awake while idle. Both screens
     * must consume the same code-native doze preparation and Z overlay; target
     * code may decide conversation activity but may not redraw its own variant.
     */
    for (const source of [stickSource, stackChanSource]) {
      expect(source).toContain("face_doze_prepare_render_key");
      expect(source).toContain("face_doze_apply_overlay");
    }
    expect(stackChanSource).toContain(
      "const bool dozing = !owner.latest_status.conversation_active;",
    );
    expect(stickSource).toContain("const bool dozing = callUiIsDozing(callUiState_);");
  });

  test("StackChan capture reuses the sole framebuffer owner without entering the audio path", () => {
    const platformSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_stackchan_avatar/stackchan_avatar.c"),
      "utf8",
    );
    const profileSource = readFileSync(
      resolve(firmwareDirectory, "devices/stackchan/stackchan.c"),
      "utf8",
    );
    const targetSource = readFileSync(
      resolve(firmwareDirectory, "targets/stackchan/main/main.c"),
      "utf8",
    );

    /*
     * A camera photograph or LCD readback would be a second, misleading UI
     * oracle. A second framebuffer owner would race the avatar. Pin capture to
     * the exact source surface, a bounded ownership window, and the S3 ROM
     * encoder. A zero-tick lock made capture race most 15 Hz renders and fail
     * spuriously; the explicit 100 ms ceiling is still finite and exists only
     * on the control owner while independent high-priority audio owners run.
     */
    expect(platformSource).toContain("owner.framebuffer[index]");
    expect(platformSource).toContain("STACKCHAN_SCREEN_CAPTURE_LOCK_TIMEOUT_MS 100U");
    expect(platformSource).toContain("pdMS_TO_TICKS(STACKCHAN_SCREEN_CAPTURE_LOCK_TIMEOUT_MS)");
    const prepareFrame = platformSource.indexOf("prepare_avatar_frame_under_lock(");
    const releaseFrame = platformSource.indexOf(
      "(void)xSemaphoreGive(owner.framebuffer_access);",
      prepareFrame,
    );
    const transferFrame = platformSource.indexOf(
      "return transfer_avatar_frame(&render_key, render_cpu_us);",
      prepareFrame,
    );
    expect(prepareFrame).toBeGreaterThanOrEqual(0);
    expect(releaseFrame).toBeGreaterThan(prepareFrame);
    expect(transferFrame).toBeGreaterThan(releaseFrame);
    expect(platformSource).toContain("MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT");
    expect(platformSource).toContain("tdefl_init(");
    expect(platformSource).toContain("tdefl_compress(");
    expect(platformSource).toContain("TDEFL_RLE_MATCHES");
    expect(platformSource).toContain("sizeof(tdefl_compressor)");
    expect(platformSource).not.toContain("tdefl_write_image_to_png_file_in_memory_ex");
    expect(platformSource).not.toContain("lv_snapshot");
    expect(platformSource).not.toContain("esp_camera_fb_get");
    expect(profileSource).toContain("iterate_kit_screen_capture_module(&device->screen_capture)");
    expect(targetSource).toContain("iterate_kit_stackchan_avatar_screen_capture_driver()");
    expect(targetSource).toContain("ITERATE_KIT_STACKCHAN_CAPTURE_PNG_CAPACITY");
  });

  test("every voice target delegates PCM lifetime and media admission to one shared session owner", () => {
    const targets = [
      {
        path: "targets/m5sticks3/main/main.cpp",
        mediaGateSink: "iterate_kit_m5sticks3_set_media_ready(",
      },
      {
        path: "targets/stackchan/main/main.c",
        mediaGateSink: "iterate_kit_audio_intent_reconciler_set_media_ready(",
      },
      {
        path: "targets/home-assistant-voice-preview-edition/main/main.c",
        mediaGateSink: "iterate_kit_audio_intent_reconciler_set_media_ready(",
      },
    ];

    for (const target of targets) {
      /*
       * Scan the whole target, not only main.c. Otherwise a future board could
       * move its private owner into target_lifecycle.c and make this test green
       * without restoring the architecture. Third-party managed components
       * are included deliberately: target-local code gets no privileged route
       * to the raw transport regardless of which subdirectory contains it.
       */
      const targetSource = sourceFiles(resolve(firmwareDirectory, dirname(dirname(target.path))))
        .map((path) => readFileSync(path, "utf8"))
        .join("\n");
      const executableTargetSource = sourceWithoutComments(targetSource);

      /*
       * Equivalent target-local loops already diverged once: Stick prewarmed
       * credentials at boot while both server-VAD boards paid 3,293 ms on the
       * first conversational edge. Pin the ownership boundary, not three
       * implementations which happen to contain similar conditionals today.
       * Targets may prepare the transport and operate their hardware lanes,
       * but only the shared session owner may start, poll, restart, or stop its
       * lifetime. This deliberately catches copied lifecycle code even when it
       * remains functionally green in a short test.
       */
      expect(targetSource).toContain("esp_idf_pcm_session.h");
      expect(executableTargetSource.match(/iterate_kit_esp_idf_pcm_session_poll\(/gu)).toHaveLength(
        1,
      );
      expect(
        executableTargetSource.match(/iterate_kit_esp_idf_pcm_session_prepare\(/gu),
      ).toHaveLength(1);
      expect(executableTargetSource).not.toMatch(/iterate_kit_esp_idf_pcm_session_poll\([^)]*,/u);
      /*
       * The session callback must be the sole hardware gate writer. A second
       * call site would let a target recreate the old private state machine by
       * racing or overriding the shared decision, even though it still calls
       * pcm_session_poll() once and superficially satisfies the ownership API.
       */
      expect(executableTargetSource.split(target.mediaGateSink).length - 1).toBe(1);
      expect(targetSource).not.toContain("pcm_transport_lifecycle.h");
      expect(targetSource).not.toMatch(
        /iterate_kit_esp_idf_pcm_transport_(?:start|poll|request_restart|request_stop|finish_stop|stop)\(/u,
      );
      expect(targetSource).not.toMatch(
        /\bbool\s+(?:pcm_started|pcm_start_attempted|pcmTransportStarted|pcmTransportStartAttempted)\b|\b(?:last_pcm_state|lastPcmTransportState)\b/u,
      );
      expect(executableTargetSource).not.toMatch(/(?:pcm_transport|pcmTransport)\.state/u);
      expect(executableTargetSource).not.toMatch(
        /conversation_active\s*&&\s*(?:status\.)?media_ready|conversationActive\s*&&\s*(?:status\.)?mediaReady/u,
      );
      expect(executableTargetSource).not.toContain("ITERATE_KIT_CONTROL_RECOVERY_RESTART_PCM");
      expect(executableTargetSource).toMatch(
        /pcm(?:_s|S)ession(?:_o|O)ptions\.conversation_active\s*=/u,
      );
      expect(executableTargetSource).toMatch(
        /pcm(?:_s|S)ession(?:_o|O)ptions\.set_media_ready\s*=/u,
      );
    }

    const publicTransportHeader = readFileSync(
      resolve(
        firmwareDirectory,
        "platforms/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_pcm_transport.h",
      ),
      "utf8",
    );
    /*
     * A source scan alone could be evaded by hiding start/poll behind a new
     * target-local wrapper. Keep lifecycle declarations out of the public
     * component include path entirely: board code can prepare the transport
     * and operate hardware-facing lanes, but bypassing the session owner then
     * fails at compilation instead of depending on a naming convention.
     */
    expect(publicTransportHeader).not.toContain("iterate_kit_esp_idf_pcm_transport_start(");
    expect(publicTransportHeader).not.toContain("iterate_kit_esp_idf_pcm_transport_poll(");
    expect(publicTransportHeader).not.toContain(
      "iterate_kit_esp_idf_pcm_transport_request_restart(",
    );

    const publicSessionHeader = readFileSync(
      resolve(
        firmwareDirectory,
        "platforms/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_pcm_session.h",
      ),
      "utf8",
    );
    expect(publicSessionHeader).not.toContain("iterate_kit_esp_idf_pcm_session_request_restart(");
    expect(publicSessionHeader).toContain("(*conversation_active)(void *context)");
    expect(publicSessionHeader).toContain("(*set_media_ready)(");

    const ownerSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_esp_idf/pcm_session.c"),
      "utf8",
    );
    expect(ownerSource).toContain("iterate_kit_esp_idf_pcm_transport_start(");
    expect(ownerSource).toContain("iterate_kit_esp_idf_pcm_transport_poll(");
    expect(ownerSource).toContain("iterate_kit_esp_idf_pcm_transport_request_restart(");
    expect(ownerSource).toContain("control_ready && conversation_active && transport_ready");
    expect(ownerSource).not.toContain("ITERATE_KIT_AUDIO_PUSH_TO_TALK");
    expect(ownerSource).not.toContain("ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC");
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

  test("StackChan retains one processed uplink through an AEC engine with double-talk protection", () => {
    const audioOwnerSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_core_s3_audio/core_s3_audio_owner.c"),
      "utf8",
    );

    const targetSource = readFileSync(
      resolve(firmwareDirectory, "targets/stackchan/main/main.c"),
      "utf8",
    );

    /*
     * A person saying “bye bye” at normal volume during StackChan playback was
     * almost entirely removed by profile 5; only a later shouted “STOP PLEASE”
     * survived. The retained profile-5 trace measured only 3--9% of raw near
     * speech reaching the clean wire during overlap, with zero clipping,
     * drops, resets, underruns or transport faults. ESP-SR 2.4.7's FD engines
     * have no double-talk detector, so lowering speaker volume cannot turn
     * that engine into a valid conversational topology. The VOIP engine is the
     * first-party path which actually runs its DTD on every frame. Keep its
     * constant processed output to avoid the old raw/processed playback-edge
     * switch, and retain the independently measured 18 dB input-headroom and
     * 80% speaker operating point. This tripwire prevents a future acoustic
     * experiment from silently shipping a no-DTD engine again.
     */
    expect(targetSource).toMatch(
      /#define STACKCHAN_AEC_PROFILE(?:\s|\\)+ITERATE_KIT_CORE_S3_AEC_VOIP_CONSTANT/u,
    );
    expect(targetSource).toContain("audio_options.aec_profile = STACKCHAN_AEC_PROFILE");
    expect(targetSource).toMatch(
      /\.frame_samples\s*=\s*iterate_kit_core_s3_aec_processing_frame_samples\(\s*STACKCHAN_AEC_PROFILE\s*\)/u,
    );
    expect(targetSource).not.toContain(
      ".frame_samples = ITERATE_KIT_CORE_S3_AEC_VOIP_FRAME_SAMPLES",
    );
    expect(audioOwnerSource).toContain("AEC_MODE_FD_LOW_COST");
    expect(audioOwnerSource).toContain("AEC_MODE_FD_HIGH_PERF");
    expect(audioOwnerSource).toContain("AEC_NLP_LEVEL_NORMAL");
    expect(audioOwnerSource).toContain("ITERATE_KIT_CORE_S3_AEC_MAX_FRAME_SAMPLES");
    expect(audioOwnerSource).toContain("owner.aec_frame_samples");
    expect(audioOwnerSource).toContain("aec_process(");
    expect(audioOwnerSource).toContain("aec_linear_process(");
    expect(audioOwnerSource).not.toMatch(/^\s*aec_nlp_process\(/mu);
    const ownerHeader = readFileSync(
      resolve(
        firmwareDirectory,
        "platforms/iterate_core_s3_audio/include/iterate/kit/platforms/core_s3_audio_owner.h",
      ),
      "utf8",
    );
    expect(ownerHeader).toContain("#define ITERATE_KIT_CORE_S3_AEC_MAX_FRAME_SAMPLES 512U");
    expect(ownerHeader).toContain("ITERATE_KIT_CORE_S3_AEC_FD_NORMAL_CONSTANT");
    expect(ownerHeader).toContain("ITERATE_KIT_CORE_S3_AEC_VOIP_SELECTOR");
    expect(ownerHeader).toContain("ITERATE_KIT_CORE_S3_AEC_VOIP_CONSTANT");
    expect(ownerHeader).toContain("ITERATE_KIT_CORE_S3_AEC_VOIP_LINEAR_CONSTANT");
    expect(ownerHeader).toContain("ITERATE_KIT_CORE_S3_AEC_FD_HIGH_PERF_CONSTANT");
    expect(ownerHeader).toContain("ITERATE_KIT_CORE_S3_AEC_FD_HIGH_PERF_LINEAR_CONSTANT");
    expect(ownerHeader).toContain("iterate_kit_core_s3_aec_processing_frame_samples(");
  });

  test("StackChan reserves Wi-Fi DMA memory before constructing VOIP AEC", () => {
    const targetSource = readFileSync(
      resolve(firmwareDirectory, "targets/stackchan/main/main.c"),
      "utf8",
    );
    const appMain = targetSource.slice(targetSource.indexOf("void app_main(void)"));

    /*
     * VOIP AEC booted successfully when it ran first, but left room for only
     * three of ESP-IDF Wi-Fi's ten mandatory static RX buffers. This order is
     * therefore a resource contract, not cosmetic startup sequencing. The
     * main poll loop still starts after both calls, so reserving network DMA
     * first cannot mount a callable device before its audio owner is ready.
     */
    expect(appMain.indexOf("iterate_kit_esp_idf_itx_transport_start(")).toBeLessThan(
      appMain.indexOf("iterate_kit_core_s3_audio_owner_start("),
    );
    expect(appMain.indexOf("iterate_kit_core_s3_audio_owner_start(")).toBeLessThan(
      appMain.indexOf("for (;;) {"),
    );
  });

  test("the StackChan microphone cannot be starved by a missing speaker callback", () => {
    const ownerHeader = readFileSync(
      resolve(
        firmwareDirectory,
        "platforms/iterate_core_s3_audio/include/iterate/kit/platforms/core_s3_audio_owner.h",
      ),
      "utf8",
    );
    const ownerSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_core_s3_audio/core_s3_audio_owner.c"),
      "utf8",
    );
    const targetSource = readFileSync(
      resolve(firmwareDirectory, "targets/stackchan/main/main.c"),
      "utf8",
    );

    /*
     * CoreS3 records the electrical amplifier divider in the same RX DMA edge
     * as the near microphone. That is the actual AEC reference. An earlier
     * design nevertheless waited for a second TX-descriptor FIFO merely to
     * decide whether the selector should publish raw or processed audio. A
     * speaker write failure then stopped TX callbacks and silently stopped an
     * otherwise healthy microphone. Pin the simpler ownership rule: RX alone
     * clocks capture, while the high-priority playback owner attaches one
     * bounded far-active bit to each capture edge.
     */
    expect(ownerHeader).toContain("int reference_gain_db;");
    expect(ownerHeader).not.toContain("core_s3_playback_reference_reserve");
    expect(ownerSource).toContain("owner.reference_gain_db");
    expect(ownerSource).not.toContain("iterate_kit_core_s3_playback_reference_reserve");
    expect(ownerSource).toContain("owner.capture_chunk.playback_content_active");
    expect(ownerSource).toContain("owner.playback_content_active");
    expect(ownerSource).toContain("owner.reference_dma");
    expect(ownerSource).not.toContain("iterate_kit_core_s3_scale_reference");
    expect(ownerSource).toMatch(
      /esp_codec_dev_set_in_channel_gain\(\s*owner\.microphone,\s*ESP_CODEC_DEV_MAKE_CHANNEL_MASK\(2\),\s*\(float\)owner\.reference_gain_db\)/,
    );
    expect(targetSource).toContain("audio_options.reference_gain_db = 0;");
    expect(targetSource).not.toContain("reference_scale_multiplier");
  });

  test("StackChan keeps the speaker below the measured nonlinear full-scale operating point", () => {
    const targetSource = readFileSync(
      resolve(firmwareDirectory, "targets/stackchan/main/main.c"),
      "utf8",
    );

    /*
     * At logical 100 the custom CoreS3 curve programs the AW88298 at 0 dB.
     * A retained real-Grok reply then railed the near microphone even though
     * the exact completed-TX reference peaked well below full scale. That is
     * an acoustic/amplifier nonlinearity which no linear echo filter can
     * reconstruct. The actual codec mapping later showed logical 90 was only
     * about 1 dB below that cliff. The 85% profile-5 physical run avoided
     * self-triggering but still lost both ends of the exact double-talk phrase.
     * Logical 80 is the last bounded high-volume operating-point experiment
     * before changing topology. Pin the choice because returning to 85/90/100
     * silently invalidates the evidence identity.
     */
    expect(targetSource).toContain("audio_options.speaker_volume_percent = 80;");
    expect(targetSource).not.toContain("audio_options.speaker_volume_percent = 85;");
    expect(targetSource).not.toContain("audio_options.speaker_volume_percent = 90;");
    expect(targetSource).not.toContain("audio_options.speaker_volume_percent = 100;");
  });

  test("StackChan improves pickup after AEC without sacrificing analogue headroom", () => {
    const targetSource = readFileSync(
      resolve(firmwareDirectory, "targets/stackchan/main/main.c"),
      "utf8",
    );
    const ownerHeader = readFileSync(
      resolve(
        firmwareDirectory,
        "platforms/iterate_core_s3_audio/include/iterate/kit/platforms/core_s3_audio_owner.h",
      ),
      "utf8",
    );

    /*
     * The constant-processed profile reached 31,932/32,767 at the near ADC
     * during far playback. Any analogue rail contact creates harmonics which
     * no linear AEC reference can represent. Keep the proven 18 dB codec PGA,
     * then make ordinary speech only 1.94 dB louder after AEC. This pins the
     * user's sensitivity fix to the observable saturating output stage instead
     * of quietly undoing the input-headroom correction.
     */
    expect(targetSource).toContain("audio_options.microphone_gain_db = 18;");
    expect(ownerHeader).toContain("#define ITERATE_KIT_CORE_S3_AEC_PROCESSED_GAIN_MULTIPLIER 10U");
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
