import {
  ITERATE_PROJECT_SCOPE_PREFIX,
  ITERATE_PROJECT_SELECTION_SCOPE,
  type IterateAuthOrganizationClaim,
  type IterateAuthProjectClaim,
} from "@iterate-com/shared/auth-claims";
import { parseStringArray } from "./db/helpers.ts";
import {
  getFreshOAuthProjectSelectionBySessionId,
  listOrganizationsForUser,
  listProjectsForUser,
} from "./db/queries/.generated/index.ts";
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
//   3. customAccessTokenClaims decodes the referenceId and narrows the
//      token's `projects` claim + `project:<id>` scope entries to the
//      selection.
//
// Refreshed tokens re-enter step 3 with the referenceId preserved by
// better-auth, so the narrowing sticks for the lifetime of the grant.
//
// Stored rows are a short-lived handoff, not durable per-user state: the
// oauth-provider does not run customAccessTokenClaims when minting opaque
// tokens (claims are reconstructed at introspection), so there is no reliable
// mint-time hook to consume the row, and consentReferenceId is invoked up to
// three times per flow so delete-on-read would break the flow. Two things
// bound the row's blast radius instead:
//
//   - postLogin.shouldRedirect sends every project-scoped authorize through
//     /project-access (better-auth only consults it on the flow's initial
//     authorize; continue/consent re-entries skip it), so the freshest row
//     for the session is always the one THIS flow just stored.
//   - Lookups are scoped to the auth browser session and ignore rows older
//     than a flow could plausibly last (the freshness window below).
//
// The postLogin hooks never receive a client id, so the lookup cannot be
// scoped to the table's full (session_id, client_id) key. The residual gap is
// two authorize flows interleaving their /project-access→consent hops inside
// one browser session within the window — the later store wins for both.
const OAUTH_PROJECT_SELECTION_REFERENCE_PREFIX = "iterate-project-selection-v1";
export const OAUTH_PROJECT_SELECTION_MAX_AGE_MS = 10 * 60 * 1000;

export async function resolveStoredProjectSelection(params: {
  sessionId: string | null | undefined;
}) {
  if (!params.sessionId) {
    return null;
  }

  const selection = await getFreshOAuthProjectSelectionBySessionId(db, {
    sessionId: params.sessionId,
    minUpdatedAt: Date.now() - OAUTH_PROJECT_SELECTION_MAX_AGE_MS,
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

export async function listOrganizationClaimsForUser(
  userId: string | null,
): Promise<IterateAuthOrganizationClaim[]> {
  if (!userId) return [];

  const organizations = await listOrganizationsForUser(db, { userId });
  return organizations.map((organization) => ({
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    role:
      organization.role === "owner" || organization.role === "admin" ? organization.role : "member",
  }));
}

// The single source of truth for what an access token grants. Two surfaces
// consume it and MUST stay identical: JWT minting (customAccessTokenClaims in
// auth-plugins.ts) and opaque-token introspection (the internal oRPC router).
// If these ever diverged, a client would get different project access
// depending on whether it happened to receive a JWT or an opaque token.
export async function buildAccessTokenGrantClaims(params: {
  userId: string | null;
  requestedScopes: string[];
  selection: { userId: string; projectIds: string[] } | null;
}): Promise<{
  organizations: IterateAuthOrganizationClaim[];
  projects: IterateAuthProjectClaim[];
  scopes: string[];
}> {
  const isProjectScoped = params.requestedScopes.includes(ITERATE_PROJECT_SELECTION_SCOPE);
  // A selection minted for a different user grants nothing; without the
  // project scope, the token grants every project the user can reach.
  const selectedProjectIds = isProjectScoped
    ? params.selection?.userId === params.userId
      ? params.selection.projectIds
      : []
    : null;

  const [organizations, allProjects] = params.userId
    ? await Promise.all([
        listOrganizationClaimsForUser(params.userId),
        listProjectsForUser(db, { userId: params.userId }),
      ])
    : [[], []];

  const selectedProjectIdSet = selectedProjectIds ? new Set(selectedProjectIds) : null;
  const projects: IterateAuthProjectClaim[] = allProjects
    .filter((project) => !selectedProjectIdSet || selectedProjectIdSet.has(project.id))
    .map((project) => ({
      id: project.id,
      slug: project.slug,
      organizationId: project.organizationId,
    }));

  return {
    organizations,
    projects,
    scopes: buildAugmentedScopeClaims({
      requestedScopes: params.requestedScopes,
      projectIds: isProjectScoped ? projects.map((project) => project.id) : [],
    }),
  };
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
