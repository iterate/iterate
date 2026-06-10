import {
  ITERATE_PROJECT_SCOPE_PREFIX,
  ITERATE_SUPERADMIN_SCOPE,
} from "@iterate-com/shared/auth-claims";
import { parseStringArray } from "./db/helpers.ts";
import { getLatestOAuthProjectSelectionByUserId } from "./db/queries/.generated/index.ts";
import { db } from "./db/index.ts";

// Project-scoped tokens: when a client requests the `project` scope, the user
// picks which projects the token may reach on the /project-access page, and
// that choice has to travel from a UI page into token minting. better-auth's
// oauth provider has no direct channel for this, so the selection makes a
// three-step trip (all wired up in auth-plugins.ts):
//
//   1. /project-access stores the chosen project ids in the
//      oauthProjectSelection table (one row per attempt, latest wins).
//   2. postLogin.consentReferenceId reads that row and encodes
//      { userId, projectIds } into the consent flow's opaque referenceId
//      (build/parse helpers below).
//   3. customAccessTokenClaims decodes the referenceId, deletes the stored
//      rows (it's a one-shot handoff, not durable state), and narrows the
//      token's `projects` claim + `project:<id>` scope entries to the
//      selection.
//
// Refreshed tokens re-enter step 3 with the referenceId preserved by
// better-auth, so the narrowing sticks for the lifetime of the grant.
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
  superadmin: boolean;
}) {
  const scopeClaims = new Set(params.requestedScopes.filter(Boolean));

  // The superadmin scope is server-granted, never client-requested: a client
  // can put it in its scope request, so being in the requested list proves
  // nothing — only the user's role does.
  scopeClaims.delete(ITERATE_SUPERADMIN_SCOPE);
  if (params.superadmin) {
    scopeClaims.add(ITERATE_SUPERADMIN_SCOPE);
  }

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
