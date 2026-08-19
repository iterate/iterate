import { z } from "zod";

import type { DeployedEnv } from "../../envs.ts";
import type { ScannerPolicyEntry } from "../../infra/cloudflare-edge-gate/policy.ts";
import { scannerPolicy } from "../../infra/cloudflare-edge-gate/policy.ts";
import { CloudflareApiError } from "../lib/env-context.ts";

const phase = "http_request_firewall_custom";
const ruleRef = "iterate_scanner_gate_block";
// This description also identifies the Alchemy-created preview rule during adoption.
const ruleDescription = "Block reviewed source and secret disclosure probes before Workers";

const Rule = z.object({
  id: z.string(),
  ref: z.string().optional(),
  action: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  expression: z.string().optional(),
});
const Ruleset = z.object({ id: z.string(), rules: z.array(Rule).default([]) });
const Zone = z.object({ id: z.string(), name: z.string() });

type Rule = z.infer<typeof Rule>;
type DesiredRule = ReturnType<typeof compileScannerGateRule> & { ref: typeof ruleRef };

export interface EdgeGateTarget {
  envName: string;
  accountId: string;
  zones: Array<{ name: string; smokeHostname: string }>;
}

export interface EdgeGateClient {
  cfV4: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
}

export function resolveEdgeGateTarget(envName: string, environment: DeployedEnv): EdgeGateTarget {
  if (envName !== "prd" && !/^preview_\d+$/.test(envName)) {
    throw new Error(`${envName} is not a production or preview edge-gate target.`);
  }
  const zones = [
    ...environment.projectHostnameBases.map((name) => ({
      name,
      smokeHostname: `edge-gate-smoke.${name}`,
    })),
    ...environment.ownedProjectCustomApexes.map((name) => ({ name, smokeHostname: name })),
  ];
  if (zones.length === 0) throw new Error(`${envName} has no edge-gate zones.`);
  return { envName, accountId: environment.cloudflareAccountId, zones };
}

export function compileScannerGateRule(entries: readonly ScannerPolicyEntry[] = scannerPolicy) {
  if (entries.length === 0) throw new Error("The scanner policy must not be empty.");
  const paths = new Set<string>();
  const extensions = new Set<string>();
  const pathWildcards = new Set<string>();
  for (const entry of entries) {
    if (entry.extension !== undefined) {
      if (!/^[a-z0-9]+$/.test(entry.extension)) {
        throw new Error(
          `Scanner extension ${JSON.stringify(entry.extension)} must be lowercase alphanumeric.`,
        );
      }
      if (extensions.has(entry.extension)) {
        throw new Error(`Duplicate scanner extension ${JSON.stringify(entry.extension)}.`);
      }
      extensions.add(entry.extension);
      continue;
    }
    if (entry.pathWildcard !== undefined) {
      if (!/^\*\/[a-z0-9._/*-]+$/.test(entry.pathWildcard) || entry.pathWildcard.includes("**")) {
        throw new Error(
          `Scanner path wildcard ${JSON.stringify(entry.pathWildcard)} must be a lowercase URI wildcard.`,
        );
      }
      if (entry.pathWildcard.includes("/.well-known")) {
        throw new Error(
          `Scanner path wildcard ${JSON.stringify(entry.pathWildcard)} could break domain validation.`,
        );
      }
      if (pathWildcards.has(entry.pathWildcard)) {
        throw new Error(`Duplicate scanner path wildcard ${JSON.stringify(entry.pathWildcard)}.`);
      }
      pathWildcards.add(entry.pathWildcard);
      continue;
    }
    if (!/^\/[a-z0-9._/-]+$/.test(entry.path)) {
      throw new Error(
        `Scanner path ${JSON.stringify(entry.path)} must be an exact, lowercase URI path.`,
      );
    }
    if (entry.path === "/.well-known" || entry.path.startsWith("/.well-known/")) {
      throw new Error(`Scanner path ${JSON.stringify(entry.path)} could break domain validation.`);
    }
    if (paths.has(entry.path)) {
      throw new Error(`Duplicate scanner path ${JSON.stringify(entry.path)}.`);
    }
    paths.add(entry.path);
  }
  const predicates = [];
  if (paths.size > 0) {
    predicates.push(
      `lower(http.request.uri.path) in {${[...paths]
        .sort()
        .map((path) => JSON.stringify(path))
        .join(" ")}}`,
    );
  }
  if (extensions.size > 0) {
    predicates.push(
      `http.request.uri.path.extension in {${[...extensions]
        .sort()
        .map((extension) => JSON.stringify(extension))
        .join(" ")}}`,
    );
  }
  predicates.push(
    ...[...pathWildcards]
      .sort()
      .map((wildcard) => `http.request.uri.path wildcard ${JSON.stringify(wildcard)}`),
  );
  const expression = predicates.length === 1 ? predicates[0] : `(${predicates.join(" or ")})`;
  if (Buffer.byteLength(expression) > 4_096) {
    throw new Error("The scanner expression exceeds Cloudflare's 4096-byte limit.");
  }
  return {
    action: "block" as const,
    description: ruleDescription,
    enabled: true as const,
    expression,
  };
}

export async function reconcileEdgeGate(
  mode: "plan" | "apply",
  target: EdgeGateTarget,
  client: EdgeGateClient,
) {
  const desired: DesiredRule = { ...compileScannerGateRule(), ref: ruleRef };
  const changes: Array<{ action: "create" | "update"; resource: string }> = [];
  for (const zone of target.zones) {
    const matches = z
      .array(Zone)
      .parse(
        await client.cfV4<unknown>(
          `/zones?account.id=${encodeURIComponent(target.accountId)}&name=${encodeURIComponent(zone.name)}&per_page=50`,
        ),
      );
    if (matches.length !== 1 || matches[0].name !== zone.name) {
      throw new Error(`Expected exactly one Cloudflare zone named ${zone.name}.`);
    }
    changes.push(...(await reconcileZoneRule(mode, zone.name, matches[0].id, desired, client)));
  }
  if (mode === "apply") {
    const drift = await reconcileEdgeGate("plan", target, client);
    if (drift.length > 0) throw new Error(`Edge gate still has drift: ${JSON.stringify(drift)}`);
  }
  return changes;
}

async function reconcileZoneRule(
  mode: "plan" | "apply",
  zoneName: string,
  zoneId: string,
  desired: DesiredRule,
  client: EdgeGateClient,
) {
  const request = <T = unknown>(path: string, init?: RequestInit) =>
    client.cfV4<T>(`/zones/${zoneId}${path}`, init);
  let entrypoint: z.infer<typeof Ruleset> | undefined;
  try {
    entrypoint = Ruleset.parse(await request<unknown>(`/rulesets/phases/${phase}/entrypoint`));
  } catch (error) {
    if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
  }

  if (!entrypoint) {
    if (mode === "apply") {
      await request("/rulesets", {
        method: "POST",
        body: JSON.stringify({
          name: "iterate-scanner-gate",
          kind: "zone",
          phase,
          description: "Iterate edge gate",
          rules: [desired],
        }),
      });
    }
    return [{ action: "create" as const, resource: `${zoneName} phase entrypoint` }];
  }

  const owned = entrypoint.rules.filter(
    (rule) =>
      rule.ref === desired.ref ||
      (rule.description === desired.description && rule.action === desired.action),
  );
  if (owned.length > 1) throw new Error(`${zoneName} has duplicate Iterate edge-gate rules.`);
  if (!owned[0]) {
    if (mode === "apply") {
      await request(`/rulesets/${entrypoint.id}/rules`, {
        method: "POST",
        body: JSON.stringify(desired),
      });
    }
    return [{ action: "create" as const, resource: `${zoneName} edge-gate rule` }];
  }
  if (!ruleMatches(owned[0], desired)) {
    if (mode === "apply") {
      const { ref: _ref, ...withoutRef } = desired;
      await request(`/rulesets/${entrypoint.id}/rules/${owned[0].id}`, {
        method: "PATCH",
        body: JSON.stringify(owned[0].ref === owned[0].id ? withoutRef : desired),
      });
    }
    return [{ action: "update" as const, resource: `${zoneName} edge-gate rule` }];
  }
  return [];
}

function ruleMatches(current: Rule, desired: DesiredRule) {
  return (
    (current.ref === desired.ref || current.ref === current.id) &&
    current.action === desired.action &&
    current.description === desired.description &&
    (current.enabled ?? true) === desired.enabled &&
    current.expression === desired.expression
  );
}

export async function verifyEdgeGateTraffic(target: EdgeGateTarget, fetcher = fetch) {
  for (const { smokeHostname } of target.zones) {
    const nonce = Date.now().toString(36);
    for (const path of ["/.env", "/app/.env.production", "/__edge-gate-smoke__.php"]) {
      let blocked: Response | undefined;
      for (let attempt = 1; attempt <= 15; attempt++) {
        blocked = await fetcher(`https://${smokeHostname}${path}?edge-gate-smoke=${nonce}`, {
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        if (blocked.status === 403 && blocked.headers.get("cf-ray")) break;
        if (attempt < 15) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      if (!blocked || blocked.status !== 403 || !blocked.headers.get("cf-ray")) {
        throw new Error(
          `Expected Cloudflare 403 for ${smokeHostname}${path} after propagation, got ${blocked?.status}.`,
        );
      }
    }
    const control = await fetcher(
      `https://${smokeHostname}/__edge-gate-control__?edge-gate-smoke=${nonce}`,
      { redirect: "manual", signal: AbortSignal.timeout(15_000) },
    );
    if (control.status === 403) {
      throw new Error(`Edge-gate control unexpectedly returned 403 for ${smokeHostname}.`);
    }
  }
}
