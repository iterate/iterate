import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";

/**
 * The durable birth certificate for one capability host.
 *
 * A host is not usable until both facts are committed: its birth certificate,
 * containing one explicit ancestor (including `null` at a root), and the
 * processor subscription that folds it.
 */
export function capabilityHostBirthEvents(input: {
  ancestorPath: string | null;
  path: string;
  projectId: string;
}) {
  const path = normalizePath(input.path);
  const ancestorPath = input.ancestorPath === null ? null : normalizePath(input.ancestorPath);
  if (ancestorPath === path) {
    throw new Error(`capability-host ${JSON.stringify(path)} cannot be its own ancestor`);
  }
  const durableObjectName = DurableObjectNameCodec.stringify({
    path,
    projectId: input.projectId,
  });
  return [
    CapabilityHostProcessorContract.buildEvent({
      type: "events.iterate.com/capability-host/created",
      idempotencyKey: `capability-host/created:${input.projectId}:${path}`,
      payload: { config: { ancestorPath } },
    }),
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${CapabilityHostProcessorContract.slug}`,
      processor: ["capabilityHosts", ["get", path], "processor"],
      processorSlug: CapabilityHostProcessorContract.slug,
    }),
  ] as const;
}
