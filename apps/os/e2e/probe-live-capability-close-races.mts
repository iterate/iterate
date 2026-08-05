/**
 * Disconnect providers while their batched mounts are crossing the stateless
 * relay -> CapabilityHost commit/bind boundary. Every iteration uses a fresh
 * host incarnation and waits for a stable empty durable table; a final sweep
 * catches mounts that appeared after an early empty observation.
 *
 *   doppler run --config dev -- pnpm exec tsx e2e/probe-live-capability-close-races.mts [iterations] [providers]
 */
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RpcTarget } from "capnweb";
import { connectItx } from "iterate/node";
import type { ItxAuthCredentials } from "../src/itx-api.generated.ts";
import { resolveBaseUrl } from "./test-support/dev-server.ts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const baseUrl = resolveBaseUrl(appRoot) ?? "";
const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
if (!baseUrl || !secret) throw new Error("need APP_CONFIG_BASE_URL + APP_CONFIG_ADMIN_API_SECRET");

const iterations = positiveInteger(process.argv[2] ?? "20", "iterations");
const providerCount = positiveInteger(process.argv[3] ?? "100", "providers");
const disconnectDelays = [0, 500, 1_500, 3_000, 6_000];
const auth: ItxAuthCredentials = { type: "admin-secret", secret };
const monitorSession = connectItx({ baseUrl });
const monitorRoot = monitorSession.authenticate(auth);
const slug = `live-lease-close-race-${crypto.randomUUID()}`;
const hostPaths: string[] = [];

class Provider extends RpcTarget {
  value(): string {
    return "must never survive owner departure";
  }
}

try {
  using monitorProject = await monitorRoot.projects.get(slug).create({});
  console.log(`created ${slug}; running ${iterations} close races with ${providerCount} providers`);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const hostPath = `/close-race/host${iteration}`;
    hostPaths.push(hostPath);
    await monitorProject.capabilityHosts.get(hostPath).create();

    const providerSession = connectItx({ baseUrl });
    const providerRoot = providerSession.authenticate(auth);
    const providerProject = providerRoot.projects.get(slug);
    const pending = Array.from({ length: providerCount }, (_, index) =>
      providerProject.capabilityHosts.get(hostPath).provideCapability({
        capability: new Provider(),
        path: ["closeRace", `provider${index}`],
        type: "live",
      }),
    );
    const delay = disconnectDelays[iteration % disconnectDelays.length]!;
    await sleep(delay);
    providerSession[Symbol.dispose]?.();

    const settled = await settleWithin(pending, 20_000, iteration);
    await waitUntilStablyEmpty(monitorProject, hostPath, 1_000);
    const fulfilled = settled.filter(({ status }) => status === "fulfilled").length;
    console.log(
      `iteration ${iteration + 1}/${iterations}: disconnected after ${delay}ms; ${fulfilled}/${providerCount} calls returned before close; durable table stably empty`,
    );
  }

  // A late append/bind must not resurrect a mount after its iteration passed.
  await sleep(3_000);
  for (const hostPath of hostPaths) {
    await assertEmpty(monitorProject, hostPath);
  }
  console.log(
    `PASS: ${iterations * providerCount} racing provisions across ${iterations} fresh hosts left no live mount`,
  );
} finally {
  monitorSession[Symbol.dispose]?.();
}

async function waitUntilStablyEmpty(
  project: ReturnType<typeof monitorRoot.projects.get>,
  hostPath: string,
  stableForMs: number,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let emptySince: number | undefined;
  while (Date.now() < deadline) {
    const empty = await isEmpty(project, hostPath);
    if (!empty) {
      emptySince = undefined;
    } else {
      emptySince ??= Date.now();
      if (Date.now() - emptySince >= stableForMs) return;
    }
    await sleep(50);
  }
  throw new Error(`${hostPath} did not reach a stable empty capability table`);
}

async function assertEmpty(
  project: ReturnType<typeof monitorRoot.projects.get>,
  hostPath: string,
): Promise<void> {
  if (await isEmpty(project, hostPath)) return;
  throw new Error(`${hostPath} resurrected a live mount after owner departure`);
}

async function isEmpty(
  project: ReturnType<typeof monitorRoot.projects.get>,
  hostPath: string,
): Promise<boolean> {
  const { capabilities } = await project.capabilityHosts.get(hostPath).__describe();
  return !capabilities.some(({ path, type }) => type === "live" && path[0] === "closeRace");
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return parsed;
}

async function settleWithin<T>(pending: Promise<T>[], timeoutMs: number, iteration: number) {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      Promise.allSettled(pending),
      sleep(timeoutMs, undefined, { signal: timeout.signal }).then(() => {
        throw new Error(`iteration ${iteration} provider promises did not settle after disconnect`);
      }),
    ]);
  } finally {
    timeout.abort();
  }
}
