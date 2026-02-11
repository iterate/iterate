export const MAX_CANONICAL_MACHINE_NAME_LENGTH = 63;
const DEFAULT_MACHINE_ID_TAIL_LENGTH = 6;

function sanitizeNamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function coalescePart(value: string, fallback: string): string {
  const sanitized = sanitizeNamePart(value);
  return sanitized || fallback;
}

export function shortenKeepingEnds(params: {
  value: string;
  maxLength: number;
  preserveEnd: number;
}): string {
  const sanitized = sanitizeNamePart(params.value);
  if (sanitized.length <= params.maxLength) return sanitized;
  if (params.maxLength <= 0) return "";

  const preserveEnd = Math.max(0, params.preserveEnd);
  const end = sanitized.slice(-preserveEnd);
  const startBudget = params.maxLength - end.length - 1;
  if (startBudget <= 0) {
    return end.slice(-params.maxLength);
  }

  const start = sanitized.slice(0, startBudget).replace(/-+$/, "");
  if (!start) return end.slice(-params.maxLength);
  return `${start}-${end}`.slice(0, params.maxLength).replace(/-+$/, "");
}

export function buildCanonicalMachineExternalId(params: {
  prefix: string;
  projectSlug: string;
  machineId: string;
  maxLength?: number;
  machineIdTailLength?: number;
}): string {
  const maxLength = params.maxLength ?? MAX_CANONICAL_MACHINE_NAME_LENGTH;
  const prefix = coalescePart(params.prefix, "dev");
  const projectSlug = coalescePart(params.projectSlug, "project");
  const machineId = coalescePart(params.machineId, "machine");
  const machineIdTailLength = params.machineIdTailLength ?? DEFAULT_MACHINE_ID_TAIL_LENGTH;

  const maxBodyLength = maxLength - prefix.length - 1;
  if (maxBodyLength <= 0) {
    throw new Error(
      `SANDBOX_NAME_PREFIX '${prefix}' is too long for max machine name length ${maxLength}`,
    );
  }

  const body = `${projectSlug}-${machineId}`;
  const shortenedBody =
    body.length <= maxBodyLength
      ? body
      : shortenKeepingEnds({
          value: body,
          maxLength: maxBodyLength,
          preserveEnd: Math.max(1, machineIdTailLength),
        });

  const canonical = `${prefix}-${shortenedBody}`.slice(0, maxLength).replace(/-+$/, "");
  if (!canonical) {
    throw new Error("Failed to build canonical machine external id");
  }
  return canonical;
}
