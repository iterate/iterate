import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";
import { buildHostedProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { ComputerProcessorContract, type ComputerConfig } from "./computer-processor-contract.ts";

const COMPUTER_PATH_PREFIX = "/computers";
const ROUND_TRIP_PROJECT_ID = "prj_roundtrip";

/** Stable one-to-one address: `/agents/foo` owns `/computers/agents/foo`. */
export function agentComputerPath(agentPath: string): string {
  return normalizeComputerPath(`${COMPUTER_PATH_PREFIX}${normalizePath(agentPath)}`);
}

export function normalizeComputerPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.startsWith(`${COMPUTER_PATH_PREFIX}/agents/`)) {
    throw new Error(
      `computer paths are agent-owned and live under ${COMPUTER_PATH_PREFIX}/agents/, got "${normalized}"`,
    );
  }
  const roundTripped = DurableObjectNameCodec.parse(
    DurableObjectNameCodec.stringify({ path: normalized, projectId: ROUND_TRIP_PROJECT_ID }),
  ).path;
  if (roundTripped !== normalized) {
    throw new Error(
      `computer path must round-trip unchanged through the Durable Object name codec, got "${normalized}" which becomes "${roundTripped}"`,
    );
  }
  return normalized;
}

export function computerCreationEvents(input: {
  agentPath: string;
  config?: Partial<ComputerConfig>;
  path: string;
  projectId: string;
}) {
  const path = normalizeComputerPath(input.path);
  const expectedPath = agentComputerPath(input.agentPath);
  if (path !== expectedPath) {
    throw new Error(
      `computer path "${path}" does not belong to agent "${input.agentPath}"; expected "${expectedPath}"`,
    );
  }
  const config = ComputerProcessorContract.stateSchema.shape.config.parse(input.config ?? {});
  const durableObjectName = DurableObjectNameCodec.stringify({ path, projectId: input.projectId });
  return [
    ComputerProcessorContract.buildEvent({
      type: "events.iterate.com/computer/created",
      idempotencyKey: `computer-created:${input.projectId}:${path}`,
      payload: { agentPath: input.agentPath, config },
    }),
    buildHostedProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${ComputerProcessorContract.slug}`,
      processor: ["computers", ["get", path], "processor"],
      processorSlug: ComputerProcessorContract.slug,
    }),
  ];
}
