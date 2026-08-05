/**
 * Live-capability lease soak (diagnostic, not part of the ordinary e2e suite).
 *
 * It keeps many Node-owned providers mounted through the real
 * Cap'n Web -> stateless relay -> hibernatable WebSocket -> CapabilityHost DO
 * lane, leaves every provider idle, and repeatedly invokes only three of
 * them. An independent Cap'n Web session heartbeats throughout so a hidden
 * shared-isolate cancellation cannot look like a successful provider test.
 *
 *   doppler run --project os --config dev -- pnpm exec tsx e2e/probe-live-capability-leases.mts [providers] [provision-concurrency] [idle-ms] [rounds] [cleanup-concurrency] [hosts] [explicit|disconnect] [cached|rederive]
 */
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RpcTarget, type RpcStub } from "capnweb";
import { connectItx } from "iterate/node";
import type {
  CapabilityHost,
  CapabilityProvision,
  ItxAuthCredentials,
} from "../src/itx-api.generated.ts";
import { resolveBaseUrl } from "./test-support/dev-server.ts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const baseUrl = resolveBaseUrl(appRoot) ?? "";
const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
if (!baseUrl || !secret) throw new Error("need APP_CONFIG_BASE_URL + APP_CONFIG_ADMIN_API_SECRET");

const providerCount = positiveInteger(process.argv[2] ?? "1000", "providers");
const provisionConcurrency = positiveInteger(process.argv[3] ?? "25", "provision concurrency");
const idleMs = positiveInteger(process.argv[4] ?? "15000", "idle milliseconds");
const rounds = positiveInteger(process.argv[5] ?? "5", "rounds");
const cleanupConcurrency = positiveInteger(process.argv[6] ?? "1", "cleanup concurrency");
const hostCount = positiveInteger(process.argv[7] ?? "1", "hosts");
const cleanupStrategy = cleanupStrategyFrom(process.argv[8] ?? "disconnect");
const accessPattern = accessPatternFrom(process.argv[9] ?? "cached");
const auth: ItxAuthCredentials = { type: "admin-secret", secret };

class SoakProvider extends RpcTarget {
  readonly calls: string[] = [];

  constructor(readonly index: number) {
    super();
  }

  value(marker: string) {
    this.calls.push(marker);
    return { index: this.index, marker };
  }
}

const startedAt = Date.now();
const providerSession = connectItx({ baseUrl });
const monitorSession = connectItx({ baseUrl });
const providerRoot = providerSession.authenticate(auth);
const monitorRoot = monitorSession.authenticate(auth);
const slug = `live-lease-soak-${crypto.randomUUID()}`;
const providers = Array.from({ length: providerCount }, (_, index) => new SoakProvider(index));
const provisions: RpcStub<CapabilityProvision>[] = [];
const hosts: RpcStub<CapabilityHost>[] = [];
let monitorRunning = true;
let heartbeats = 0;
let heartbeatFailure: unknown;
let providerSessionDisposed = false;

const heartbeat = (async () => {
  while (monitorRunning) {
    try {
      await monitorRoot.__describe();
      heartbeats += 1;
    } catch (error) {
      heartbeatFailure = error;
      monitorRunning = false;
      return;
    }
    await sleep(100);
  }
})();

try {
  using project = await providerRoot.projects.get(slug).create({});
  if (hostCount === 1) {
    hosts.push(project.capabilityHost);
  } else {
    await inBatches(hostCount, provisionConcurrency, async (index) => {
      hosts[index] = await project.capabilityHosts.get(`/soak/host${index}`).create();
    });
  }
  console.log(
    `created ${slug} with ${hostCount} capability host(s); provisioning ${providerCount} providers at concurrency ${provisionConcurrency} via ${accessPattern} host handles`,
  );

  const hostFor = (index: number) =>
    accessPattern === "cached"
      ? hosts[index % hostCount]!
      : project.capabilityHosts.get(hostPath(index % hostCount));

  await inBatches(providerCount, provisionConcurrency, async (index) => {
    provisions[index] = await hostFor(index).provideCapability({
      capability: providers[index]!,
      path: ["soak", `provider${index}`],
      type: "live",
    });
  });
  assertMonitorHealthy();
  console.log(
    `provided ${provisions.length} leases in ${elapsedSeconds()}s; leaving every provider idle for ${idleMs}ms`,
  );

  await sleep(idleMs);
  assertMonitorHealthy();
  const leaseHealth = await Promise.all(provisions.map((provision) => provision.ping()));
  const inactive = leaseHealth.flatMap((active, index) => (active ? [] : [index]));
  if (inactive.length > 0) {
    throw new Error(`idle leases became inactive: ${inactive.slice(0, 20).join(", ")}`);
  }

  const selected = [...new Set([0, Math.floor(providerCount / 2), providerCount - 1])];
  for (let round = 1; round <= rounds; round += 1) {
    const expected = selected.map((index) => ({ index, marker: `round-${round}` }));
    const actual = await Promise.all(
      selected.map((index) =>
        hostFor(index).invokeCapability({
          args: [`round-${round}`],
          path: ["soak", `provider${index}`, "value"],
        }),
      ),
    );
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `selective invocation mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
    for (const provider of providers) {
      const expectedCalls = selected.includes(provider.index) ? round : 0;
      if (provider.calls.length !== expectedCalls) {
        throw new Error(
          `provider ${provider.index} received ${provider.calls.length} calls after round ${round}; expected ${expectedCalls}`,
        );
      }
    }
    assertMonitorHealthy();
    console.log(
      `round ${round}/${rounds}: selected ${selected.join(", ")} only; ${heartbeats} independent heartbeats healthy`,
    );
    if (round < rounds) await sleep(idleMs);
  }

  console.log(
    `PASS: ${providerCount} providers, ${selected.length} selectively active per round, ${rounds} rounds, ${heartbeats} heartbeats, ${elapsedSeconds()}s`,
  );
} finally {
  const mountedProvisions = provisions.flatMap((provision) =>
    provision === undefined ? [] : [provision],
  );
  if (cleanupStrategy === "disconnect") {
    console.log(`disconnecting the provider session with ${mountedProvisions.length} provisions`);
    providerSession[Symbol.dispose]?.();
    providerSessionDisposed = true;
    await waitForSessionRevocation();
    await assertSingleDepartureEventPerHost();
  } else {
    console.log(`revoking ${mountedProvisions.length} provisions`);
    await inBatches(mountedProvisions.length, cleanupConcurrency, async (index) => {
      await mountedProvisions[index]!.revoke();
      mountedProvisions[index]![Symbol.dispose]();
    });
  }
  monitorRunning = false;
  await heartbeat;
  if (!providerSessionDisposed) providerSession[Symbol.dispose]?.();
  monitorSession[Symbol.dispose]?.();
}

async function waitForSessionRevocation(): Promise<void> {
  const deadline = Date.now() + 30_000;
  using observedProject = monitorRoot.projects.get(slug);
  while (true) {
    const descriptions = await Promise.all(
      Array.from({ length: hostCount }, (_, index) =>
        observedProject.capabilityHosts.get(hostPath(index)).__describe(),
      ),
    );
    const remaining = descriptions.flatMap(({ capabilities }) =>
      capabilities.filter(({ path, type }) => type === "live" && path[0] === "soak"),
    );
    if (remaining.length === 0) {
      console.log("provider-session departure durably revoked every live mount");
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `provider-session departure left ${remaining.length} live mounts after 30000ms`,
      );
    }
    await sleep(100);
  }
}

/**
 * A provider session owns one physical channel per CapabilityHost. Session
 * departure must therefore journal one plural revocation per host, regardless
 * of how often the caller re-derived its public host handle. This catches a
 * regression back to one hidden channel/socket/close turn per provider.
 */
async function assertSingleDepartureEventPerHost(): Promise<void> {
  using observedProject = monitorRoot.projects.get(slug);
  for (let hostIndex = 0; hostIndex < hostCount; hostIndex += 1) {
    const departures = await observedProject.streams.get(hostPath(hostIndex)).getEvents({
      eventTypes: ["events.iterate.com/capability-host/capabilities-revoked"],
      limit: 500,
    });
    if (departures.length !== 1) {
      throw new Error(
        `host ${hostPath(hostIndex)} journaled ${departures.length} plural departures; expected exactly one shared channel`,
      );
    }
    const revocations = departures[0]?.payload?.revocations;
    const expected = providers.filter(
      (provider) => provider.index % hostCount === hostIndex,
    ).length;
    if (!Array.isArray(revocations) || revocations.length !== expected) {
      throw new Error(
        `host ${hostPath(hostIndex)} departure contains ${Array.isArray(revocations) ? revocations.length : "no"} revocations; expected ${expected}`,
      );
    }
  }
  console.log(`journal proves exactly ${hostCount} physical provider channel(s)`);
}

function hostPath(index: number): string {
  return hostCount === 1 ? "/" : `/soak/host${index}`;
}

function assertMonitorHealthy(): void {
  if (heartbeatFailure === undefined) return;
  throw new Error("independent Cap'n Web heartbeat failed", { cause: heartbeatFailure });
}

async function inBatches(
  count: number,
  concurrency: number,
  operation: (index: number) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < count; start += concurrency) {
    const end = Math.min(start + concurrency, count);
    await Promise.all(
      Array.from({ length: end - start }, (_, offset) => operation(start + offset)),
    );
  }
}

function elapsedSeconds(): string {
  return ((Date.now() - startedAt) / 1_000).toFixed(1);
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return parsed;
}

function cleanupStrategyFrom(value: string): "disconnect" | "explicit" {
  if (value === "disconnect" || value === "explicit") return value;
  throw new Error(`cleanup strategy must be explicit or disconnect, got ${value}`);
}

function accessPatternFrom(value: string): "cached" | "rederive" {
  if (value === "cached" || value === "rederive") return value;
  throw new Error(`access pattern must be cached or rederive, got ${value}`);
}
