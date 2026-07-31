import {
  kitControlWebsocketErrorTypeName,
  parseKitControlDiagnostics,
} from "./kit-control-diagnostics.ts";
import type { KitControlDiagnostics } from "./kit-device-contract.ts";
import type { DeviceDisconnectReason } from "./local-device-peer.ts";

interface DiagnosticsDevice {
  getDiagnostics(): Promise<unknown>;
}

interface DiagnosticsMount {
  readonly device: DiagnosticsDevice;
  readonly disconnected: Promise<DeviceDisconnectReason>;
  readonly generation: number;
}

interface DiagnosticsPeer {
  waitForMountAfter(generation: number): Promise<DiagnosticsMount>;
}

export type ControlMountOutcome =
  | {
      kind: "ended";
      generation: number;
      reason: Exclude<DeviceDisconnectReason, "replaced">;
    }
  | {
      diagnostics: KitControlDiagnostics;
      errorTypeName: ReturnType<typeof kitControlWebsocketErrorTypeName>;
      kind: "replaced";
      previousDisconnectReason: Exclude<DeviceDisconnectReason, "peer-disposed">;
      previousGeneration: number;
      replacementGeneration: number;
    };

export type ControlMountSettlement =
  | {
      kind: "observed";
      outcome: ControlMountOutcome;
    }
  | {
      error: unknown;
      kind: "observation-failed";
    }
  | {
      kind: "timed-out";
      waitedMs: number;
    };

/*
 * Realtime work has already failed before either of these clocks matters.
 * They deliberately do not alter the one-second capability deadline or PCM
 * freshness policy. The 25-second inner bound outlives the measured
 * 17.2-second M5StickS3 station outage so a replacement generation can expose
 * the retained ESP-IDF cause; the 30-second outer bound still gives teardown
 * one absolute, finite deadline if remount or diagnostics never complete.
 */
export const controlMountReconnectTimeoutMs = 25_000;
export const controlMountDiagnosticGraceTimeoutMs = 30_000;

/*
 * This observer does not make reconnect healthy. A clean endurance run still
 * requires one uninterrupted control generation; replacement merely opens the
 * only session from which the device can report why its predecessor died.
 * Both remount and one-shot RPC are bounded so diagnosis cannot turn a failed
 * realtime run into another indefinite wait.
 */
export async function observeControlMountOutcome(options: {
  mount: DiagnosticsMount;
  peer: DiagnosticsPeer;
  timeoutMs?: number;
}): Promise<ControlMountOutcome> {
  const reason = await options.mount.disconnected;
  if (reason === "peer-disposed") {
    return {
      generation: options.mount.generation,
      kind: "ended",
      reason,
    };
  }
  /*
   * Cap'n Web disposes local RPC targets when their socket dies. At this
   * boundary ProvisionTarget cannot distinguish that automatic disposal from
   * an explicit remote revoke, so both `replaced` and `revoked` can describe
   * a generation whose replacement contains the only retained causal state.
   * The bounded wait below preserves correctness for a genuinely final revoke:
   * it yields a diagnostic timeout, never a recovered/healthy run.
   */
  const timeoutMs = options.timeoutMs ?? controlMountReconnectTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("The control reconnect diagnostics timeout must be positive.");
  }
  const replacement = await withTimeout(
    options.peer.waitForMountAfter(options.mount.generation),
    timeoutMs,
    "Timed out waiting for the replacement control capability mount.",
  );
  const diagnostics = parseKitControlDiagnostics(
    await withTimeout(
      replacement.device.getDiagnostics(),
      timeoutMs,
      "Timed out reading retained control diagnostics from the replacement mount.",
    ),
  );
  return {
    diagnostics,
    errorTypeName: kitControlWebsocketErrorTypeName(diagnostics.control.lastErrorType),
    kind: "replaced",
    previousDisconnectReason: reason,
    previousGeneration: options.mount.generation,
    replacementGeneration: replacement.generation,
  };
}

/*
 * A capability timeout stops new load at its source, but immediately rejecting
 * the whole E2E run closes the local server and destroys the replacement
 * session that carries the only retained cause. This helper grants that
 * already-running observer one fixed grace window. It neither retries the RPC
 * nor treats reconnect as recovery; callers still fail the original run after
 * receiving evidence or the timeout classification.
 */
export function settleControlMountOutcome(options: {
  outcome: PromiseLike<ControlMountOutcome>;
  timeoutMs?: number;
}): Promise<ControlMountSettlement> {
  const timeoutMs = options.timeoutMs ?? controlMountDiagnosticGraceTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("The control diagnostic grace timeout must be positive.");
  }
  let timeout: NodeJS.Timeout | undefined;
  const observed = Promise.resolve(options.outcome)
    .then<ControlMountSettlement>((outcome) => ({
      kind: "observed",
      outcome,
    }))
    .catch<ControlMountSettlement>((error: unknown) => ({
      error,
      kind: "observation-failed",
    }));
  const timedOut = new Promise<ControlMountSettlement>((resolve) => {
    timeout = setTimeout(
      () =>
        resolve({
          kind: "timed-out",
          waitedMs: timeoutMs,
        }),
      timeoutMs,
    );
  });
  return Promise.race([observed, timedOut]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function withTimeout<Value>(operation: PromiseLike<Value>, timeoutMs: number, message: string) {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    Promise.resolve(operation),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
