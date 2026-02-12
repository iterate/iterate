export const MAX_CANONICAL_MACHINE_NAME_LENGTH = 63;

export function sanitizeNamePart(value: string): string {
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
  if (preserveEnd === 0) {
    return sanitized.slice(0, params.maxLength).replace(/-+$/, "");
  }

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
}): string {
  const maxLength = params.maxLength ?? MAX_CANONICAL_MACHINE_NAME_LENGTH;
  const prefix = coalescePart(params.prefix, "dev");
  const projectSlug = coalescePart(params.projectSlug, "project");
  const machineId = coalescePart(params.machineId, "machine");

  const prefixMachineLength = prefix.length + machineId.length + 2;
  const maxProjectSlugLength = maxLength - prefixMachineLength;
  if (maxProjectSlugLength < 1) {
    throw new Error(
      `Machine id '${machineId}' is too long for max machine name length ${maxLength} with prefix '${prefix}'`,
    );
  }

  const shortenedProjectSlug = shortenKeepingEnds({
    value: projectSlug,
    maxLength: maxProjectSlugLength,
    preserveEnd: 0,
  });
  if (!shortenedProjectSlug) {
    throw new Error(`Project slug '${projectSlug}' cannot be represented safely`);
  }

  const canonical = `${prefix}-${shortenedProjectSlug}-${machineId}`;
  if (!canonical) {
    throw new Error("Failed to build canonical machine external id");
  }
  return canonical;
}
