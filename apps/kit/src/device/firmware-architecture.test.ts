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
    expect(bindFunction).toContain("audioOwner_.begin(lane)");
    expect(targetSource.indexOf("initialiseRings(runtime)")).toBeLessThan(
      targetSource.indexOf("iterate_kit_esp_idf_itx_transport_start("),
    );
    expect(targetSource.indexOf("initialiseRings(runtime)")).toBeLessThan(
      targetSource.indexOf("iterate_kit_esp_idf_pcm_transport_start("),
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

  test("the M5StickS3 display calibration preserves the colours seen by a person", () => {
    const platformSource = readFileSync(
      resolve(firmwareDirectory, "platforms/iterate_m5unified/m5unified.cpp"),
      "utf8",
    );

    /*
     * TFT_RED/TFT_GREEN are 16-bit RGB565 constants. Storing either in this
     * adapter's uint32_t retained colour and passing it to M5GFX's 32-bit
     * overload reinterprets the bits as RGB888: the first physical deployment
     * consequently rendered requested red as green and a guessed constant swap
     * then rendered it blue. Keep this boundary explicitly RGB888; framebuffer
     * capture can verify the bytes while the nearby person verifies the panel.
     */
    expect(platformSource).toContain("m5StickS3PhysicalRed = 0xFF0000U");
    expect(platformSource).toContain("m5StickS3PhysicalGreen = 0x00FF00U");
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
     * misleading than no UI. Requiring the colour capability to repaint the
     * current view also prevents a Grok tool call from erasing the controls.
     */
    expect(platformSource).toContain("TOP: start call");
    expect(platformSource).toContain("Hold FRONT to talk");
    expect(platformSource).toContain("Release FRONT to send");
    expect(platformSource).toContain("AI SPEAKING");
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
    expect(targetSource).toContain("runtime.pcmTransport.state");
    expect(targetSource).toContain("iterate_kit_m5sticks3_is_capturing(&state.device)");
    expect(targetSource).toContain("RealtimePlaybackState::playing");
  });

  test("the Stick establishes its PCM lane before a person starts a call", () => {
    const targetSource = readFileSync(
      resolve(firmwareDirectory, "targets/m5sticks3/main/main.cpp"),
      "utf8",
    );
    const transportLifecycle = sourceSection(
      targetSource,
      "const iterate_kit_status transportPoll =",
      "const auto playbackPoll =",
    );

    /*
     * A physical trace measured only 33 ms in userspace and 1.48 s through
     * Grok, but 5.52 s from Button B to a newly opened device socket. TLS and
     * WebSocket setup therefore belong to device readiness, not interactive
     * call setup. Reintroducing conversation-owned start/stop would preserve
     * functional tests while restoring exactly the delay a person reported.
     */
    expect(transportLifecycle).toContain("iterate_kit_esp_idf_pcm_transport_start(");
    expect(transportLifecycle).not.toContain("iterate_kit_esp_idf_pcm_transport_request_stop(");
    expect(transportLifecycle).not.toContain("conversationActive &&");
    expect(targetSource).not.toContain("pcmTransportStartAttemptedForConversation");
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
