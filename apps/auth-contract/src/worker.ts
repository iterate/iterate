import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  IterateAuthAccessTokenOrganizationClaim,
  IterateAuthProjectClaim,
} from "@iterate-com/shared/auth-claims";
import type {
  InternalCreateProjectForOrganizationInput,
  InternalIntrospectOAuthAccessTokenInput,
  ProjectInput,
  ProjectRecord,
} from "./index.ts";

export type ProjectCreationResult =
  | { ok: true; project: ProjectRecord }
  | {
      ok: false;
      reason: "organization_not_found" | "conflict";
      message: string;
    };

/** The identity fields OS needs for its short stale-claims membership check. */
export type UserProjectRecord = {
  id: string;
  slug: string;
  organizationId: string;
};

export type OAuthAccessTokenIntrospectionResult =
  | {
      active: false;
      reason: "not_found" | "expired" | "client_disabled" | "missing_user" | "session_expired";
    }
  | {
      active: true;
      sub: string;
      sid?: string;
      clientId: string;
      iss: string;
      aud: string | string[];
      iat: number;
      exp: number;
      scope: string;
      scopes: string[];
      organizations: IterateAuthAccessTokenOrganizationClaim[];
      projects: IterateAuthProjectClaim[];
      isAdmin: boolean;
      role: string | null;
    };

export type MintProjectAppSessionInput = {
  audience: string;
  projectId: string;
  userId: string;
};

export type ValidateProjectAppSessionInput = {
  audience: string;
  projectId: string;
  token: string;
};

/** The actor proven by a project-app session after its live membership check. */
export type ValidatedProjectAppSession = {
  expiresAt: number;
  userId: string;
};

/**
 * The RPC contract of auth's default Worker entrypoint. Auth also implements
 * public HTTP `fetch`, but it is deliberately absent from this client contract.
 * The required service binding is the credential for these methods; they have
 * no HTTP or bearer-token fallback.
 */
export abstract class AuthWorker<Env = unknown> extends WorkerEntrypoint<Env> {
  abstract createProjectForOrganization(
    input: InternalCreateProjectForOrganizationInput,
  ): Promise<ProjectCreationResult>;
  abstract getProjectBySlug(input: ProjectInput): Promise<ProjectRecord | null>;
  abstract listProjectsForUser(input: { userId: string }): Promise<UserProjectRecord[]>;
  abstract mintProjectAppSession(
    input: MintProjectAppSessionInput,
  ): Promise<{ token: string } | null>;
  abstract validateProjectAppSession(
    input: ValidateProjectAppSessionInput,
  ): Promise<ValidatedProjectAppSession | null>;
  abstract mintProjectId(): Promise<{ id: string }>;
  abstract introspectAccessToken(
    input: InternalIntrospectOAuthAccessTokenInput,
  ): Promise<OAuthAccessTokenIntrospectionResult>;
}
