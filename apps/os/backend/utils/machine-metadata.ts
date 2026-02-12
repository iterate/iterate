function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TRANSIENT_TOP_LEVEL_MACHINE_METADATA_KEYS = new Set([
  "provisioningError",
  "daemonStatus",
  "daemonStatusMessage",
  "daemonReadyAt",
  "host",
  "port",
  "ports",
  "containerId",
  "containerName",
  "sandboxName",
]);

function stripNestedRuntimeKey(params: {
  metadata: Record<string, unknown>;
  parentKey: string;
  childKey: string;
}): void {
  const { metadata, parentKey, childKey } = params;
  const nested = metadata[parentKey];
  if (!isRecord(nested)) return;

  const updated = { ...nested };
  delete updated[childKey];

  if (Object.keys(updated).length === 0) {
    delete metadata[parentKey];
    return;
  }

  metadata[parentKey] = updated;
}

/**
 * Remove machine-state/runtime metadata while preserving config/intent metadata.
 *
 * Deny-list by design: we only strip known-bad transient keys that should not be
 * carried between machines or retained after successful provisioning.
 */
export function stripMachineStateMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned = { ...metadata };

  for (const key of TRANSIENT_TOP_LEVEL_MACHINE_METADATA_KEYS) {
    delete cleaned[key];
  }

  stripNestedRuntimeKey({ metadata: cleaned, parentKey: "fly", childKey: "machineId" });
  stripNestedRuntimeKey({ metadata: cleaned, parentKey: "daytona", childKey: "sandboxId" });
  stripNestedRuntimeKey({ metadata: cleaned, parentKey: "docker", childKey: "containerRef" });

  return cleaned;
}
