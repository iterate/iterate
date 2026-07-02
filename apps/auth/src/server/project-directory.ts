import {
  InternalCreateProjectForOrganizationInput,
  InternalIntrospectOAuthAccessTokenInput,
  ProjectInput,
  type InternalIntrospectOAuthAccessTokenOutput,
  type ProjectRecord,
  type UserProjectRecord,
} from "@iterate-com/auth-contract";
import { ORPCError } from "@orpc/server";
import { z } from "zod/v4";
import { db } from "./db/index.ts";
import { env } from "./env.ts";
import { hashOAuthStoredValue, parseStringArray } from "./db/helpers.ts";
import {
  getOAuthAccessTokenForInternalIntrospection,
  getOrganizationBySlug,
  getProjectWithOrganizationBySlug,
  insertProjectReturning,
  listProjectsForUser as listProjectsForUserQuery,
} from "./db/queries/index.ts";
import {
  buildAccessTokenGrantClaims,
  parseOAuthProjectSelectionReferenceId,
} from "./oauth-project-selection.ts";
import { isPlatformAdminUser } from "./platform-admin.ts";
import { resolveProjectCreateTarget } from "./orpc/routers/project-slugs.ts";
import { generateId, toProjectRecordFromReturnedRow } from "./orpc/routers/_shared.ts";

// The auth worker is the project DIRECTORY and the id AUTHORITY for the whole
// platform: it owns the org/project tables users manage through OAuth-time
// project selection, and it is the only minter of the `prj_` id space (OS
// never invents ids that could collide). OS workers call these functions over
// the AUTH service binding — see the AuthWorkerRpc doc in
// @iterate-com/auth-contract for the trust model, and
// apps/auth/src/server/worker.ts for the entrypoint that exposes them.
//
// Inputs are zod-parsed even though callers are first-party workers: RPC
// crosses a deploy boundary, and the two sides can be skewed mid-rollout.
//
// Errors are ORPCError so the conflict/not-found vocabulary stays shared with
// the oRPC routers (project-slugs.ts serves both). Over Workers RPC they
// arrive as plain Errors — the message survives, the code does not — and no
// OS caller branches on codes.

/** See AuthWorkerRpc.mintProjectId. */
export async function mintProjectId(): Promise<{ id: string }> {
  return { id: generateId("prj") };
}

/** See AuthWorkerRpc.createProjectForOrganization. */
export async function createProjectForOrganization(
  rawInput: InternalCreateProjectForOrganizationInput,
): Promise<ProjectRecord> {
  const input = InternalCreateProjectForOrganizationInput.parse(rawInput);
  const organization = await getOrganizationBySlug(db, {
    slug: input.organizationSlug,
  });
  if (!organization) {
    throw new ORPCError("NOT_FOUND", { message: "Organization not found" });
  }

  const target = await resolveProjectCreateTarget({
    db,
    id: input.id,
    name: input.name,
    organizationId: organization.id,
    slug: input.slug,
  });
  if (target.kind === "existing") {
    return toProjectRecordFromReturnedRow(target.project);
  }

  const now = Date.now();
  const created = await insertProjectReturning(db, {
    id: input.id ?? generateId("prj"),
    organizationId: organization.id,
    name: input.name,
    slug: target.slug,
    metadata: JSON.stringify(input.metadata ?? {}),
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  if (!created) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Failed to create project" });
  }

  return toProjectRecordFromReturnedRow(created);
}

/** See AuthWorkerRpc.getProjectBySlug. Callers enforce their own
 * authorization — OS ingress only maps slug -> id, and OS server reads check
 * the reader's org membership themselves. */
export async function getProjectBySlug(rawInput: ProjectInput): Promise<ProjectRecord | null> {
  const input = ProjectInput.parse(rawInput);
  const projectRow = await getProjectWithOrganizationBySlug(db, {
    slug: input.projectSlug,
  });
  return projectRow && toProjectRecordFromReturnedRow(projectRow);
}

/** See AuthWorkerRpc.listProjectsForUser. Same query the OAuth project claims
 * are built from (auth-plugins.ts), so OS's stale-claims fallback and the
 * token claims can never disagree. */
export async function listProjectsForUser(rawInput: {
  userId: string;
}): Promise<UserProjectRecord[]> {
  const input = z.object({ userId: z.string().min(1) }).parse(rawInput);
  const projects = await listProjectsForUserQuery(db, { userId: input.userId });
  return projects.map((project) => ({
    id: project.id,
    slug: project.slug,
    organizationId: project.organizationId,
  }));
}

// The generated row types declare these `date` columns as number, but D1
// returns Better Auth's date columns as ISO-8601 strings at runtime — accept
// both shapes rather than trust the declared type.
function toMillis(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * See AuthWorkerRpc.introspectAccessToken. RFC 7662-style introspection of an
 * OPAQUE OAuth access token — OS's MCP server calls this over the AUTH binding
 * for clients (e.g. Grok) that present opaque bearers instead of verifiable
 * JWTs. The grant claims are rebuilt with the SAME builder JWT minting uses
 * (auth-plugins customAccessTokenClaims), so opaque and JWT tokens reconstruct
 * identical grants.
 */
export async function introspectAccessToken(
  rawInput: InternalIntrospectOAuthAccessTokenInput,
): Promise<InternalIntrospectOAuthAccessTokenOutput> {
  const input = InternalIntrospectOAuthAccessTokenInput.parse(rawInput);
  const token = await getOAuthAccessTokenForInternalIntrospection(db, {
    token: await hashOAuthStoredValue(input.token),
  });
  if (!token) return { active: false, reason: "not_found" };

  const expiresAtMs = toMillis(token.expiresAt);
  if (!expiresAtMs || expiresAtMs <= Date.now()) return { active: false, reason: "expired" };
  if (token.clientDisabled === 1) return { active: false, reason: "client_disabled" };
  if (!token.userId) return { active: false, reason: "missing_user" };

  // A token whose session row was deleted (session FK on-delete-set-null)
  // stays active until its own expiry — matching stock better-auth
  // introspection and JWT access tokens (which outlive their session until
  // `exp`). Where a live session reference exists we are stricter and reject
  // tokens whose session has expired.
  if (token.sessionId) {
    const sessionExpiresAtMs = toMillis(token.sessionExpiresAt);
    if (!sessionExpiresAtMs || sessionExpiresAtMs <= Date.now()) {
      return { active: false, reason: "session_expired" };
    }
  }

  const grants = await buildAccessTokenGrantClaims({
    userId: token.userId,
    requestedScopes: parseStringArray(token.scopes),
    selection: parseOAuthProjectSelectionReferenceId(token.referenceId),
  });
  const role = token.userRole ?? null;

  return {
    active: true,
    sub: token.userId,
    // sessionId is nullable (FK on-delete-set-null); the contract models an
    // absent session as undefined, not null.
    sid: token.sessionId ?? undefined,
    clientId: token.clientId,
    iss: `${env.VITE_AUTH_APP_ORIGIN.replace(/\/+$/, "")}/api/auth`,
    aud: input.audiences,
    iat: Math.floor((toMillis(token.createdAt) ?? Date.now()) / 1000),
    exp: Math.floor(expiresAtMs / 1000),
    scope: grants.scopes.join(" "),
    scopes: grants.scopes,
    organizations: grants.organizations,
    projects: grants.projects,
    isAdmin: isPlatformAdminUser({ role }),
    role,
  };
}
