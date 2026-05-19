import { ITERATE_PROJECT_SCOPE_PREFIX } from "@iterate-com/shared/auth-claims";
import { parseStringArray } from "./db/helpers.ts";
import { getLatestOAuthProjectSelectionByUserId } from "./db/queries/.generated/index.ts";
import { db } from "./db/index.ts";

const OAUTH_PROJECT_SELECTION_REFERENCE_PREFIX = "iterate-project-selection-v1";

export async function resolveStoredProjectSelection(params: { userId: string | null | undefined }) {
  if (!params.userId) {
    return null;
  }

  const selection = await getLatestOAuthProjectSelectionByUserId(db, {
    userId: params.userId,
  });
  if (!selection) {
    return null;
  }

  return normalizeProjectIds(parseStringArray(selection.projectIds));
}

export function buildOAuthProjectSelectionReferenceId(params: {
  projectIds: string[];
  userId: string;
}) {
  const payload = JSON.stringify({
    projectIds: normalizeProjectIds(params.projectIds),
    userId: params.userId,
  });

  return `${OAUTH_PROJECT_SELECTION_REFERENCE_PREFIX}:${encodeBase64Url(payload)}`;
}

export function parseOAuthProjectSelectionReferenceId(referenceId: string | null | undefined) {
  if (!referenceId?.startsWith(`${OAUTH_PROJECT_SELECTION_REFERENCE_PREFIX}:`)) {
    return null;
  }

  const encodedPayload = referenceId.slice(OAUTH_PROJECT_SELECTION_REFERENCE_PREFIX.length + 1);
  try {
    const decodedPayload = decodeBase64Url(encodedPayload);
    const parsed = JSON.parse(decodedPayload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const parsedRecord = parsed as Record<string, unknown>;
    const userId = typeof parsedRecord.userId === "string" ? parsedRecord.userId : null;
    const rawProjectIds = Array.isArray(parsedRecord.projectIds) ? parsedRecord.projectIds : null;

    if (!userId || !rawProjectIds) {
      return null;
    }

    return {
      userId,
      projectIds: normalizeProjectIds(
        rawProjectIds.filter((projectId): projectId is string => typeof projectId === "string"),
      ),
    };
  } catch {
    return null;
  }
}

export function buildAugmentedScopeClaims(params: {
  projectIds: string[];
  requestedScopes: string[];
}) {
  const scopeClaims = new Set(params.requestedScopes.filter(Boolean));

  for (const projectId of normalizeProjectIds(params.projectIds)) {
    scopeClaims.add(`${ITERATE_PROJECT_SCOPE_PREFIX}${projectId}`);
  }

  return Array.from(scopeClaims);
}

function normalizeProjectIds(projectIds: Iterable<string>) {
  return Array.from(
    new Set(
      Array.from(projectIds)
        .map((projectId) => projectId.trim())
        .filter((projectId) => projectId.length > 0),
    ),
  ).sort();
}

function encodeBase64Url(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64Url(value: string) {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
