import { createCaptunTunnel, type CaptunTunnel } from "captun";
import {
  LocalFetchWebSocketServer,
  type LocalFetchWebSocketBridgeMetrics,
  type LocalFetchWebSocketBridgeOpenEvent,
} from "./local-fetch-websocket-server.ts";
import type {
  PhysicalNetworkPcmEvidence,
  PhysicalNetworkRunProgress,
  TimedLocalFetchWebSocketBridgeClose,
} from "./physical-network-run.ts";

type FixtureFetch = (request: Request) => Response | Promise<Response>;

interface DirectLanSelection {
  host: string;
  port?: number;
}

export interface AecFixtureTransportOptions {
  directLan?: DirectLanSelection;
  fetch: FixtureFetch;
  gateway: string;
  onBridgeClosed?: (metrics: LocalFetchWebSocketBridgeMetrics) => void;
  onBridgeOpened?: (event: LocalFetchWebSocketBridgeOpenEvent) => void;
  token?: string;
  tunnelName?: string;
}

interface CaptunLike {
  [Symbol.dispose](): void;
  url: string;
}

interface DirectLanLike {
  baseUrl: string;
  close(): Promise<void>;
}

interface AecFixtureTransportDependencies {
  createTunnel?: (options: {
    fetch: FixtureFetch;
    gateway: string;
    name?: string;
    token: string;
  }) => Promise<CaptunLike>;
  listenDirect?: (options: {
    fetch: FixtureFetch;
    host: string;
    onBridgeClosed?: (metrics: LocalFetchWebSocketBridgeMetrics) => void;
    onBridgeOpened?: (event: LocalFetchWebSocketBridgeOpenEvent) => void;
    port?: number;
  }) => Promise<DirectLanLike>;
}

export interface AecFixtureTransport {
  baseUrl: string;
  close(): Promise<void>;
  kind: "captun" | "direct-lan";
}

/**
 * Selects the truthful terminal PCM witness for the chosen transport.
 *
 * The direct-LAN adapter owns a Node WebSocket bridge and can report its exact
 * open/close state. Captun passes Fetch WebSocketPairs directly and never
 * creates that bridge, so synthesizing an empty local-bridge history makes a
 * healthy public run indeterminate. Captun instead uses the device's sampled
 * connection counters plus exact recorder progress, the same evidence shape
 * used by deployed workers.
 */
export function aecFixturePcmEvidence(options: {
  bridgeCloseEvents: readonly TimedLocalFetchWebSocketBridgeClose[];
  bridgeOpenEvents: readonly LocalFetchWebSocketBridgeOpenEvent[];
  progress: PhysicalNetworkRunProgress;
  transportKind: AecFixtureTransport["kind"];
}): PhysicalNetworkPcmEvidence {
  if (options.transportKind === "captun") {
    return { kind: "device-observed", progress: { ...options.progress } };
  }
  return {
    bridgeEvidence: {
      closeEvents: [...options.bridgeCloseEvents],
      historyTruncated: false,
      openEvents: [...options.bridgeOpenEvents],
    },
    kind: "local-bridge",
    progress: { ...options.progress },
  };
}

/**
 * Exposes one fixture application through either production-shaped Captun or
 * an explicit LAN isolation route.
 *
 * The transport is intentionally below authentication and audio generation:
 * both choices receive the exact same `LocalDevicePeerServer.fetch` function.
 * This prevents a smooth LAN run from accidentally qualifying a second,
 * friendlier implementation of `/api`, `/pcm`, or project-secret checking.
 */
export async function openAecFixtureTransport(
  options: AecFixtureTransportOptions,
  dependencies: AecFixtureTransportDependencies = {},
): Promise<AecFixtureTransport> {
  let closed = false;
  if (options.directLan) {
    const listenDirect =
      dependencies.listenDirect ??
      ((directOptions) => LocalFetchWebSocketServer.listen(directOptions));
    const direct = await listenDirect({
      fetch: options.fetch,
      host: options.directLan.host,
      ...(options.onBridgeClosed ? { onBridgeClosed: options.onBridgeClosed } : {}),
      ...(options.onBridgeOpened ? { onBridgeOpened: options.onBridgeOpened } : {}),
      ...(options.directLan.port === undefined ? {} : { port: options.directLan.port }),
    });
    return {
      baseUrl: direct.baseUrl,
      async close() {
        if (closed) return;
        closed = true;
        await direct.close();
      },
      kind: "direct-lan",
    };
  }

  const token = options.token?.trim();
  if (!token) {
    throw new Error("CAPTUN_TOKEN is required for the default public AEC fixture transport.");
  }
  const createTunnel =
    dependencies.createTunnel ??
    ((tunnelOptions) => createCaptunTunnel(tunnelOptions) as Promise<CaptunTunnel>);
  const tunnel = await createTunnel({
    fetch: options.fetch,
    gateway: options.gateway,
    ...(options.tunnelName ? { name: options.tunnelName } : {}),
    token,
  });
  return {
    baseUrl: tunnel.url,
    async close() {
      if (closed) return;
      closed = true;
      tunnel[Symbol.dispose]();
    },
    kind: "captun",
  };
}
