import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { RpcTarget } from "capnweb";
import { z } from "zod";
import type { Env } from "./control-plane.ts";
import { directory, type Org, type Project } from "./directory.ts";
import { projectHostOf } from "./hosts.ts";
import { appConfigOf } from "./app-config.ts";
import { codedError } from "./lib.ts";
import {
  authorizationOf,
  oauthAddresses,
  oauthHelpers,
  parseAuthorization,
  type AccessGrant,
  type GrantProps,
} from "./oauth.ts";

export type ConsentView =
  | {
      kind: "consent";
      query: string;
      clientName: string;
      email: string;
      projects: Project[];
      orgs: Org[];
      projectBound: boolean;
      scopes: string[];
      denyLocation: string;
    }
  | { kind: "redirect"; location: string }
  | { kind: "invalid"; description: string };

/** A platform-served project CIMD client can receive only that project's authority. */
async function projectsForClient(env: Env, clientId: string, userId: string) {
  const projects = await directory(env.DB).listProjects(userId);
  const url = URL.canParse(clientId) ? new URL(clientId) : null;
  const host =
    url?.pathname === "/.auth/client.json"
      ? projectHostOf(url.hostname, appConfigOf(env).projectHostnameBase)
      : null;
  if (!host) return { projects, projectBound: false };
  const project = await directory(env.DB).getProject(host.project);
  return { projects: projects.filter((p) => p.id === project?.id), projectBound: true };
}

/** Expected OAuth refusals retain the validated client redirect when one exists. */
function authorizationFailure(
  error: unknown,
): Extract<ConsentView, { kind: "redirect" | "invalid" }> {
  if (error instanceof CimdFetchError)
    return {
      kind: "invalid",
      description: "The client metadata could not be loaded or validated.",
    };
  if (!(error instanceof AuthorizationError)) throw error;
  if (!error.redirectUri) return { kind: "invalid", description: error.description };
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return { kind: "redirect", location: redirect.href };
}

/** This capability exists only on the grant minted by verified issuer sign-in.
 * Account scope and a copied issuer client ID never confer approval authority. */
export class Consent extends RpcTarget {
  readonly #env: Env;
  readonly #grant: AccessGrant;
  constructor(env: Env, grant: AccessGrant) {
    super();
    if (grant.kind !== "issuer")
      throw codedError("FORBIDDEN", "Sign in to Iterate to approve access.");
    this.#env = env;
    this.#grant = grant;
  }
  async #request(query: unknown) {
    // Issuing a new grant must not spend the live transport's revocation grace.
    if (!(await authorizationOf(this.#env, this.#grant)))
      throw codedError("UNAUTHENTICATED", "This session has ended. Sign in again.");
    const search = z.string().parse(query).replace(/^\?/, "");
    return parseAuthorization(
      this.#env,
      new Request(`${oauthAddresses(this.#env).issuer}/authorize?${search}`),
    );
  }
  async describe(query: string): Promise<ConsentView> {
    const env = this.#env;
    try {
      const request = await this.#request(query);
      const client = await oauthHelpers(env).lookupClient(request.clientId);
      const denied = new URL(request.redirectUri);
      denied.searchParams.set("error", "access_denied");
      denied.searchParams.set("error_description", "The user declined access.");
      if (request.state) denied.searchParams.set("state", request.state);
      if (request.issuer) denied.searchParams.set("iss", request.issuer);
      return {
        kind: "consent",
        query,
        denyLocation: denied.href,
        clientName: client?.clientName ?? request.clientId,
        email: this.#grant.email,
        scopes: request.scope,
        orgs: await directory(env.DB).listOrgs(this.#grant.userId),
        ...(await projectsForClient(env, request.clientId, this.#grant.userId)),
      };
    } catch (error) {
      return authorizationFailure(error);
    }
  }
  async approve(input: {
    query: string;
    projects: string[];
  }): Promise<{ redirectTo: string } | { error: string }> {
    const env = this.#env;
    const data = z.object({ query: z.string(), projects: z.array(z.string()) }).parse(input);
    try {
      const request = await this.#request(data.query);
      const client = await oauthHelpers(env).lookupClient(request.clientId);
      const { projects, projectBound } = await projectsForClient(
        env,
        request.clientId,
        this.#grant.userId,
      );
      const checked = new Set(data.projects);
      const granted = projects.filter((p) => checked.has(p.id)).map((p) => p.id);
      const allProjects = !projectBound && checked.has("*");
      if (!allProjects && !granted.length)
        return { error: "Choose at least one project you can access." };
      return await oauthHelpers(env).completeAuthorization({
        request,
        userId: this.#grant.userId,
        metadata: { clientName: client?.clientName ?? request.clientId },
        scope: request.scope,
        revokeExistingGrants: false,
        props: {
          kind: "app",
          version: 2,
          userId: this.#grant.userId,
          email: this.#grant.email,
          projects: allProjects ? null : granted,
          deadline: Date.now() + 30 * 24 * 3600_000,
        } satisfies GrantProps,
      });
    } catch (error) {
      const failure = authorizationFailure(error);
      return failure.kind === "redirect"
        ? { redirectTo: failure.location }
        : { error: failure.description };
    }
  }
}
