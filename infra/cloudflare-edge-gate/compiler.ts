import type { ScannerPathPolicyEntry } from "./policy.ts";

const MAX_EXPRESSION_BYTES = 4_096;
const SAFE_EXACT_PATH = /^\/[a-z0-9._/-]+$/;

export interface ScannerGateRule {
  action: "block";
  description: string;
  enabled: true;
  expression: string;
}

export function compileScannerGateRule(
  entries: readonly ScannerPathPolicyEntry[],
): ScannerGateRule {
  if (entries.length === 0) {
    throw new Error("The scanner path policy must contain at least one exact path.");
  }

  const paths = new Set<string>();
  for (const entry of entries) {
    validatePolicyEntry(entry, paths);
    paths.add(entry.path);
  }

  const sortedPaths = [...paths].sort();
  const expression = `lower(http.request.uri.path) in {${sortedPaths
    .map((path) => JSON.stringify(path))
    .join(" ")}}`;

  if (Buffer.byteLength(expression, "utf8") > MAX_EXPRESSION_BYTES) {
    throw new Error(
      `The scanner path expression exceeds Cloudflare's ${MAX_EXPRESSION_BYTES}-byte limit.`,
    );
  }

  return {
    action: "block",
    description: "Block reviewed source and secret disclosure probes before Workers",
    enabled: true,
    expression,
  };
}

export function compileProductionDeploymentExpression(zoneNames: readonly string[]): string {
  if (zoneNames.length === 0) {
    throw new Error("The production scanner gate must target at least one zone.");
  }

  const uniqueZoneNames = [...new Set(zoneNames)];
  if (uniqueZoneNames.length !== zoneNames.length) {
    throw new Error("The production scanner gate contains a duplicate zone name.");
  }

  for (const zoneName of uniqueZoneNames) {
    if (!/^[a-z0-9.-]+$/.test(zoneName) || zoneName.startsWith(".") || zoneName.endsWith(".")) {
      throw new Error(`Invalid production scanner-gate zone ${JSON.stringify(zoneName)}.`);
    }
  }

  const zoneSet = uniqueZoneNames
    .sort()
    .map((zoneName) => JSON.stringify(zoneName))
    .join(" ");
  return `(cf.zone.plan eq "ENT" and cf.zone.name in {${zoneSet}})`;
}

function validatePolicyEntry(entry: ScannerPathPolicyEntry, existingPaths: ReadonlySet<string>) {
  if (!SAFE_EXACT_PATH.test(entry.path) || entry.path !== entry.path.toLowerCase()) {
    throw new Error(
      `Scanner path ${JSON.stringify(entry.path)} must be an exact, lowercase URI path.`,
    );
  }
  if (entry.path === "/.well-known" || entry.path.startsWith("/.well-known/")) {
    throw new Error(`Scanner path ${JSON.stringify(entry.path)} could break domain validation.`);
  }
  if (existingPaths.has(entry.path)) {
    throw new Error(`Duplicate scanner path ${JSON.stringify(entry.path)}.`);
  }
  if (entry.reason.trim().length === 0) {
    throw new Error(`Scanner path ${JSON.stringify(entry.path)} needs a reviewable reason.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.evidence.observedOn)) {
    throw new Error(`Scanner path ${JSON.stringify(entry.path)} needs an ISO evidence date.`);
  }
  if (
    !Number.isSafeInteger(entry.evidence.productionInvocations) ||
    entry.evidence.productionInvocations <= 0
  ) {
    throw new Error(`Scanner path ${JSON.stringify(entry.path)} needs a positive observed count.`);
  }
  if (entry.evidence.source.trim().length === 0) {
    throw new Error(`Scanner path ${JSON.stringify(entry.path)} needs an evidence source.`);
  }
}
