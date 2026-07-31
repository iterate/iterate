import { describe, expect, test, vi } from "vitest";
import type { KitControlDiagnostics } from "./kit-device-contract.ts";
import {
  controlMountDiagnosticGraceTimeoutMs,
  controlMountReconnectTimeoutMs,
  observeControlMountOutcome,
  settleControlMountOutcome,
} from "./control-mount-diagnostics.ts";

function diagnostics(): KitControlDiagnostics {
  return {
    schemaVersion: 3,
    producedAtMs: 100_139,
    control: {
      websocketStartAttempts: 2,
      websocketConnections: 2,
      websocketDisconnects: 1,
      websocketErrors: 1,
      wifiDisconnects: 0,
      protocolFailures: 0,
      receiveFailures: 0,
      sendFailures: 0,
      lastWifiDisconnectReason: 0,
      lastErrorGeneration: 1,
      lastErrorType: 2,
      lastTlsError: 0,
      lastTlsStackError: 0,
      lastTransportErrno: 0,
      lastHandshakeStatusCode: 0,
      lastCloseStatusCode: 0,
      protocolFailureGeneration: 1,
      lastApplicationCapnwebGeneration: 1,
      lastApplicationCapnwebStatus: -4,
      lastControlReceiveStatus: 0,
      messagesSent: 371,
      messagesDiscarded: 8,
      inboxDiscarded: 0,
      outboxDiscarded: 8,
      inbox: {
        capacitySlots: 4,
        messagesPublished: 812,
        messagesConsumed: 812,
        producerBackpressure: 0,
        highWaterSlots: 3,
        currentSlots: 0,
      },
      outbox: {
        capacitySlots: 8,
        messagesPublished: 1_204,
        messagesConsumed: 1_196,
        producerBackpressure: 1,
        highWaterSlots: 8,
        currentSlots: 0,
      },
    },
    network: {
      wifiConnected: true,
      wifiRssiDbm: -67,
      pcmWebsocketConnections: 2,
      pcmWebsocketDisconnects: 1,
      pcmWebsocketErrors: 0,
    },
  };
}

describe("control mount diagnostics", () => {
  test("the default observer outlives the measured station outage", async () => {
    /*
     * The physical ICMP trace contains a 17.2-second interval in which the
     * Stick's station IP is completely unreachable. A six-second postmortem
     * timer always destroyed the server before the replacement generation
     * could return ESP-IDF's retained disconnect tuple. This is diagnostic
     * patience after an already-failed realtime run—not permission to buffer,
     * retry, or accept stale audio.
     */
    vi.useFakeTimers();
    try {
      const replacement = {
        device: {
          getDiagnostics: vi.fn().mockResolvedValue(diagnostics()),
        },
        disconnected: new Promise<never>(() => {}),
        generation: 2,
      };
      const result = observeControlMountOutcome({
        mount: {
          device: { getDiagnostics: vi.fn() },
          disconnected: Promise.resolve("replaced"),
          generation: 1,
        },
        peer: {
          waitForMountAfter: vi.fn().mockImplementation(
            () =>
              new Promise((resolve) => {
                setTimeout(() => resolve(replacement), 17_200);
              }),
          ),
        },
      });

      await vi.advanceTimersByTimeAsync(17_200);
      await expect(result).resolves.toMatchObject({
        kind: "replaced",
        replacementGeneration: 2,
      });
      expect(controlMountReconnectTimeoutMs).toBeGreaterThan(17_200);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the default settlement remains a bounded postmortem window", async () => {
    /*
     * Extending observation must not create an unbounded teardown. Keep one
     * explicit outer deadline longer than the reconnect stage, and prove that
     * a peer which never returns still produces a classified timeout.
     */
    vi.useFakeTimers();
    try {
      expect(controlMountDiagnosticGraceTimeoutMs).toBeGreaterThan(controlMountReconnectTimeoutMs);
      const result = settleControlMountOutcome({
        outcome: new Promise<never>(() => {}),
      });

      await vi.advanceTimersByTimeAsync(controlMountDiagnosticGraceTimeoutMs - 1);
      let settled = false;
      void result.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual({
        kind: "timed-out",
        waitedMs: controlMountDiagnosticGraceTimeoutMs,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("waits for reconnect evidence before allowing a control-load failure to tear down", async () => {
    /*
     * The first eight-slot physical failure closed the local server as soon as
     * getDiagnostics exceeded its one-second deadline. That destroyed the
     * replacement session before it could return the retained queue counters.
     * Load must stop immediately elsewhere, but this gate keeps only the
     * diagnostic transport alive until the already-running observer settles.
     */
    let resolveOutcome!: (value: Awaited<ReturnType<typeof observeControlMountOutcome>>) => void;
    const outcome = new Promise<Awaited<ReturnType<typeof observeControlMountOutcome>>>(
      (resolve) => {
        resolveOutcome = resolve;
      },
    );
    let settled = false;
    const result = settleControlMountOutcome({ outcome, timeoutMs: 25 }).then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    resolveOutcome({
      diagnostics: diagnostics(),
      errorTypeName: "pongTimeout",
      kind: "replaced",
      previousDisconnectReason: "replaced",
      previousGeneration: 1,
      replacementGeneration: 2,
    });

    await expect(result).resolves.toMatchObject({
      kind: "observed",
      outcome: {
        kind: "replaced",
        previousGeneration: 1,
        replacementGeneration: 2,
      },
    });
  });

  test("bounds diagnostic grace when the failed generation never disconnects", async () => {
    vi.useFakeTimers();
    try {
      const result = settleControlMountOutcome({
        outcome: new Promise<never>(() => {}),
        timeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toEqual({
        kind: "timed-out",
        waitedMs: 25,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses the replacement generation to recover the dead socket's retained SDK error", async () => {
    /*
     * The old callback cannot report its own transport death. This models the
     * physical 1006 incident: generation one is replaced, generation two
     * returns the retained PONG-timeout tuple, and the result remains a failed
     * generation rather than an automatic endurance recovery.
     */
    const waitForMountAfter = vi.fn().mockResolvedValue({
      device: {
        getDiagnostics: vi.fn().mockResolvedValue(diagnostics()),
      },
      disconnected: new Promise<never>(() => {}),
      generation: 2,
    });

    await expect(
      observeControlMountOutcome({
        mount: {
          device: { getDiagnostics: vi.fn() },
          disconnected: Promise.resolve("replaced"),
          generation: 1,
        },
        peer: { waitForMountAfter },
      }),
    ).resolves.toMatchObject({
      diagnostics: {
        control: {
          lastErrorGeneration: 1,
          lastErrorType: 2,
        },
      },
      errorTypeName: "pongTimeout",
      kind: "replaced",
      previousGeneration: 1,
      replacementGeneration: 2,
    });
    expect(waitForMountAfter).toHaveBeenCalledWith(1);
  });

  test("treats target revocation during socket teardown as a reconnect evidence boundary", async () => {
    /*
     * A physical Cap'n Web socket failure disposes the provision target. The
     * local target currently reports that lifecycle callback as `revoked`
     * whether or not firmware explicitly requested revocation. Stopping at
     * that label lost the only chance to read the dead generation's retained
     * transport counters from its automatic replacement. Waiting is safe:
     * this observer is bounded, and a genuinely final revoke simply times out
     * without changing the already-failed endurance result.
     */
    const waitForMountAfter = vi.fn().mockResolvedValue({
      device: {
        getDiagnostics: vi.fn().mockResolvedValue(diagnostics()),
      },
      disconnected: new Promise<never>(() => {}),
      generation: 2,
    });

    await expect(
      observeControlMountOutcome({
        mount: {
          device: { getDiagnostics: vi.fn() },
          disconnected: Promise.resolve("revoked"),
          generation: 1,
        },
        peer: { waitForMountAfter },
      }),
    ).resolves.toMatchObject({
      kind: "replaced",
      previousDisconnectReason: "revoked",
      previousGeneration: 1,
      replacementGeneration: 2,
    });
    expect(waitForMountAfter).toHaveBeenCalledWith(1);
  });

  test("does not classify intentional peer disposal as a reconnect failure", async () => {
    const waitForMountAfter = vi.fn();

    await expect(
      observeControlMountOutcome({
        mount: {
          device: { getDiagnostics: vi.fn() },
          disconnected: Promise.resolve("peer-disposed"),
          generation: 7,
        },
        peer: { waitForMountAfter },
      }),
    ).resolves.toEqual({
      generation: 7,
      kind: "ended",
      reason: "peer-disposed",
    });
    expect(waitForMountAfter).not.toHaveBeenCalled();
  });

  test("bounds a replacement that mounts but cannot return diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const result = observeControlMountOutcome({
        mount: {
          device: { getDiagnostics: vi.fn() },
          disconnected: Promise.resolve("replaced"),
          generation: 1,
        },
        peer: {
          waitForMountAfter: vi.fn().mockResolvedValue({
            device: {
              getDiagnostics: vi.fn().mockReturnValue(new Promise<never>(() => {})),
            },
            disconnected: new Promise<never>(() => {}),
            generation: 2,
          }),
        },
        timeoutMs: 25,
      });
      const rejection = expect(result).rejects.toThrow(
        "Timed out reading retained control diagnostics from the replacement mount.",
      );

      await vi.advanceTimersByTimeAsync(25);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
