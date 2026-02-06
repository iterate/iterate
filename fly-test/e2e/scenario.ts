import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ObservabilityProvider } from "./providers/types.ts";

type ScenarioConfig = {
  artifactDir: string;
  targetUrl: string;
  blockedUrl: string;
  log: (line: string) => void;
};

type FetchResponse = {
  ok?: boolean;
  status?: string;
  body?: string;
  proofDetected?: boolean;
  error?: string;
};

function parseFetchResponse(raw: string): FetchResponse {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("sandbox returned empty response");
  try {
    return JSON.parse(trimmed) as FetchResponse;
  } catch {
    throw new Error(`sandbox returned non-JSON response: ${trimmed.slice(0, 200)}`);
  }
}

function assertAllowed(result: FetchResponse): void {
  if (!result.ok) {
    throw new Error(`allowed fetch failed: ${result.error ?? "unknown error"}`);
  }
  if (!result.proofDetected && !result.body?.startsWith("__ITERATE_MITM_PROOF__")) {
    throw new Error("allowed response missing proof prefix in body");
  }
}

function assertBlocked(result: FetchResponse): void {
  const blockedByStatus = result.status === "451";
  const blockedByBody = (result.body ?? "").toLowerCase().includes("policy violation");
  const blockedByError = (result.error ?? "").toLowerCase().includes("policy");
  if (!blockedByStatus && !blockedByBody && !blockedByError) {
    throw new Error("blocked response missing policy signal");
  }
}

function assertLogs(sandboxLog: string, egressLog: string): void {
  if (!/FETCH_(OK|ERROR)/.test(sandboxLog)) {
    throw new Error("sandbox log missing FETCH marker");
  }
  if (!/MITM_REQUEST/.test(egressLog)) {
    throw new Error("egress log missing MITM_REQUEST");
  }
  if (!/(TRANSFORM_OK|POLICY_BLOCK)/.test(egressLog)) {
    throw new Error("egress log missing transform/policy marker");
  }
}

export async function runScenario(
  provider: ObservabilityProvider,
  config: ScenarioConfig,
): Promise<void> {
  await provider.up();
  try {
    config.log(`Running shared integration scenario via provider=${provider.name}`);

    const allowedRaw = await provider.sandboxFetch({
      url: config.targetUrl,
      method: "GET",
    });
    writeFileSync(
      join(config.artifactDir, "allowed-fetch-response.json"),
      `${allowedRaw.trim()}\n`,
    );
    const allowed = parseFetchResponse(allowedRaw);
    assertAllowed(allowed);

    const blockedRaw = await provider.sandboxFetch({
      url: config.blockedUrl,
      method: "GET",
    });
    writeFileSync(
      join(config.artifactDir, "blocked-fetch-response.json"),
      `${blockedRaw.trim()}\n`,
    );
    const blocked = parseFetchResponse(blockedRaw);
    assertBlocked(blocked);

    const sandboxLog = await provider.readSandboxLog();
    const egressLog = await provider.readEgressLog();
    writeFileSync(join(config.artifactDir, "sandbox-ui.log"), sandboxLog);
    writeFileSync(join(config.artifactDir, "egress-proxy.log"), egressLog);
    assertLogs(sandboxLog, egressLog);

    config.log("SUCCESS");
    config.log(`Artifacts: ${config.artifactDir}`);
  } finally {
    await provider.down();
  }
}
