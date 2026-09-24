import { z } from "zod";
import { CimdFetchError, type GrantSummary } from "@cloudflare/workers-oauth-provider";
import { RpcTarget } from "capnweb";
import { codedError, isLocalOrigin, reportIssue } from "iterate/lib";
import type { GrantRecord } from "iterate/api";
import { type GrantEnded, type PersonalAccessTokenMinted } from "./account/contract.ts";
import type { PlatformAddresses } from "./app-config.ts";
import type { Env } from "./env.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import {
  accountStateOf,
  grantIsLive,
  oauthHelpers,
  revokeGrant,
  type Authorization,
} from "./oauth.ts";
import { ClientDisplayUrl, clientDisplay } from "./client-display.ts";
import {
  indexPersonalAccessToken,
  newPersonalAccessToken,
  unindexPersonalAccessToken,
} from "./personal-access-token.ts";
import { appendPlatformFacts } from "./session.ts";

const DisplayMetadata = z.object({
  clientName: z.string().optional(),
  logoUri: ClientDisplayUrl.optional().catch(undefined),
  clientDomain: z.string().optional(),
});
const MintInput = z.object({
  name: z.string().trim().min(1).max(100),
  projects: z.array(z.string()).min(1),
  /** A device's public CIMD client (Kit's Prepare device): the key is listed as that device, with
   *  the name and logo its metadata document gives. */
  clientId: z.url({ protocol: /^https$/ }).optional(),
  /** Epoch ms. Absent: the key never expires, and ends only when it is revoked. */
  expiresAt: z.number().int().positive().optional(),
});

/** Whether this deployment mints personal access tokens: a bearer that acts as a person must only
 *  ever travel over TLS — or to the local worker (`localhost`, `127.0.0.1`), where `pnpm dev` and
 *  the e2e vitest project speak plain http on the loopback. Any other http issuer is refused. */
const mintsPersonalAccessTokens = (issuer: string): boolean =>
  issuer.startsWith("https:") || isLocalOrigin(issuer);

/** A PERSON'S SESSIONS AND KEYS: their OAuth grants (the provider's inventory) and their personal
 *  access tokens (their account's records, personal-access-token.ts), listed and ended alike, and
 *  where a key is minted. Account capabilities are consented independently of project access. */
export class GrantsRpcTarget extends RpcTarget {
  readonly #env: Env;
  readonly #auth: Authorization;
  /** where this session reached the platform (app-config.ts `platformAddressesOf`) */
  readonly #addresses: PlatformAddresses;
  constructor(env: Env, auth: Authorization, addresses: PlatformAddresses) {
    super();
    this.#env = env;
    this.#auth = auth;
    this.#addresses = addresses;
  }
  #account() {
    const grant = this.#auth.grant;
    if (!grant?.scope.includes("account"))
      throw codedError(
        "FORBIDDEN",
        "Account permission is required to manage sessions and personal access tokens.",
      );
    return { sub: grant.userId, email: grant.email, reach: this.#auth.reach, grant };
  }
  /** A PLATFORM FACT ON THE ACCOUNT THE VERB AWAITS, stamped with this session: a key's record, or
   *  an end. Stamped `source.platform` (session.ts `appendPlatformFacts`): the account folds
   *  nothing else, so a fact a person appends themselves mints and revokes nothing. */
  async #land(userId: string, fact: Parameters<typeof appendPlatformFacts>[2]): Promise<void> {
    await appendPlatformFacts(this.#env.ITERATE_CONTEXT, { account: userId }, fact, {
      principal: this.#auth.principal,
      grant: this.#auth.grant?.grantId,
    });
  }
  /** A grant's or a key's end: from the moment it lands, every admission of it is refused (oauth.ts
   *  reads the account's `endedGrants`), whatever the provider's rows still say. Keyed on its id. */
  #landGrantEnded(userId: string, grantId: string) {
    return this.#land(userId, {
      type: "events.iterate.com/account/grant-ended",
      idempotencyKey: `account/grant-ended/${grantId}`,
      payload: { grantId } satisfies GrantEnded,
    });
  }
  /** A key's index entry (personal-access-token.ts) goes AFTER its end landed on the account, the
   *  revocation truth: an entry that outlives a failed delete admits nothing, so a failure is
   *  reported, not thrown. The key's hash is `key`'s, or its record's on the account. */
  async #unindex(userId: string, id: string, key?: { hash: string }) {
    try {
      const hash = (key || (await accountStateOf(this.#env, userId)).personalAccessTokens[id])
        ?.hash;
      if (hash) await unindexPersonalAccessToken(this.#env.OAUTH_KV, hash);
    } catch (error) {
      reportIssue("personal-access-token.unindex-failed", error, { id });
    }
  }
  /** Any client can end its own grant, and a personal access token its own key. It cannot address
   *  another user's session. */
  async endCurrent() {
    const grant = this.#auth.grant;
    if (!grant) throw codedError("FORBIDDEN", "The administrator credential has no user session.");
    await this.#landGrantEnded(grant.userId, grant.grantId);
    // a key has no provider rows to clean up: its end on the account, then its index entry
    if (grant.kind === "personal") await this.#unindex(grant.userId, grant.grantId);
    else await revokeGrant(this.#env, this.#addresses, grant);
  }

  /** The person's personal access tokens (their account, on the first page), then a page of their
   *  OAuth grants (the provider's inventory); the account says which have ended and when each was
   *  last used. */
  async list(cursor?: string) {
    const env = this.#env;
    const session = this.#account();
    const [page, account] = await Promise.all([
      oauthHelpers(env, this.#addresses).listUserGrants(session.sub, { limit: 50, cursor }),
      accountStateOf(env, session.sub),
    ]);
    const now = Date.now();
    const keys = cursor
      ? []
      : Object.entries(account.personalAccessTokens).flatMap(([id, key]): GrantRecord[] => {
          if (account.endedGrants[id]) return [];
          return [
            {
              id,
              name: key.name,
              kind: key.device ? "device" : "personal",
              clientId: key.device?.clientId,
              logoUri: key.device?.logoUri,
              clientDomain: key.device?.clientDomain,
              projects: key.projects,
              createdAt: Date.parse(key.mintedAt),
              expiresAt: key.expiresAt,
              lastUsedAt: account.grantUses[id]?.at ?? null,
              current: id === session.grant.grantId,
              expired: key.expiresAt !== null && key.expiresAt <= now,
              mintedBy: key.mintedBy,
            },
          ];
        });
    const { api, mcp } = this.#addresses;
    const resourceNames = new Map<string, GrantRecord["resource"]>([
      [api, "api"],
      [mcp, "mcp"],
    ]);
    const sessions = page.items.flatMap((grant): GrantRecord[] => {
      if (account.endedGrants[grant.id]) return [];
      const metadata = DisplayMetadata.parse(grant.metadata ?? {});
      // The provider stores an unexchanged grant with the code's ten-minute KV TTL.
      const expiresAt = (grant.expiresAt ?? grant.createdAt + 600) * 1000;
      return [
        {
          id: grant.id,
          name: metadata.clientName || grant.clientId,
          clientId: grant.clientId,
          logoUri: metadata.logoUri,
          clientDomain: metadata.clientDomain,
          kind: grant.expiresAt ? "session" : "pending",
          resource: resourceNames.get(String(grant.resource)),
          createdAt: grant.createdAt * 1000,
          expiresAt,
          lastUsedAt: account.grantUses[grant.id]?.at ?? null,
          current: grant.id === session.grant.grantId,
          expired: expiresAt <= now,
        },
      ];
    });
    return {
      items: [...keys, ...sessions],
      cursor: page.cursor,
      projects: await new ControlPlane(env.CONTROL_PLANE).reachableProjects(session.reach),
      canMintToken: mintsPersonalAccessTokens(this.#addresses.platformOrigin),
    };
  }

  /** Ownership comes from the account (a key it holds, or an end already there) or a full provider
   * inventory scan — an arbitrary foreign id ends nothing. The end lands on the account FIRST and
   * is awaited (the revocation truth); then an OAuth grant's provider rows go, or a key's index
   * entry. `/api`, `/mcp` and the project hosts refuse it at once; a connection it holds open (an
   * `/api` socket, rpc.ts; a project host's WebSocket or streamed body, project-host-lease.ts)
   * closes at its next 30 s re-check. */
  async end(grantId: string) {
    const env = this.#env;
    const session = this.#account();
    const account = await accountStateOf(env, session.sub);
    const key = account.personalAccessTokens[grantId];
    if (!key && !account.endedGrants[grantId]) {
      let owned: GrantSummary | undefined;
      let cursor: string | undefined;
      do {
        const page = await oauthHelpers(env, this.#addresses).listUserGrants(session.sub, {
          cursor,
        });
        owned = page.items.find((grant) => grant.id === grantId);
        cursor = page.cursor;
      } while (!owned && cursor);
      if (!owned) throw codedError("GRANT_NOT_FOUND", "Session not found");
    }
    await this.#landGrantEnded(session.sub, grantId);
    if (key) await this.#unindex(session.sub, grantId, key);
    else await revokeGrant(env, this.#addresses, { userId: session.sub, grantId });
  }

  /** A PERSONAL ACCESS TOKEN (personal-access-token.ts): a key of this person's, scoped to the
   * `projects` named (each one they reach), expiring at `expiresAt` or never, revocable from
   * `list`/`end` like any grant. Its bearer is answered ONCE: the account keeps its SHA-256 alone.
   * The bearer acts as the person, with the `iterate` scope, at `/api`, at `/mcp` and on a covered
   * project's hosts (oauth.ts `validateToken`). The key's index entry and its record land before
   * the bearer is answered, so it works at once; the record names the session that minted it
   * (`mintedBy`), which the list shows. */
  async mint(input: unknown) {
    const env = this.#env;
    const session = this.#account();
    if (!(await grantIsLive(env, session.grant)))
      throw codedError("UNAUTHENTICATED", "This session has ended. Sign in again.");
    const data = MintInput.parse(input);
    if (!mintsPersonalAccessTokens(this.#addresses.platformOrigin))
      throw codedError("FORBIDDEN", "Personal access tokens require an HTTPS deployment.");
    if (data.expiresAt && data.expiresAt < Date.now() + 60_000)
      throw codedError("INVALID_INPUT", "expiresAt must be at least a minute away.");
    const projects = (
      await new ControlPlane(env.CONTROL_PLANE).reachableProjects(session.reach, data.projects)
    )
      .filter((project) => data.projects.includes(project.id))
      .map((project) => project.id);
    if (!projects.length) throw codedError("FORBIDDEN", "Choose a project you can access.");
    let device: PersonalAccessTokenMinted["device"];
    if (data.clientId) {
      const { logoUri, clientDomain } = clientDisplay(
        await this.#deviceClient(data.clientId),
        data.clientId,
      );
      device = { clientId: data.clientId, logoUri, clientDomain };
    }
    const { id, token, hash } = await newPersonalAccessToken(session.sub);
    const expiresAt = data.expiresAt ?? null;
    // The index entry first, then the record: an entry whose record fails to land admits nothing
    // (the account refuses a key it does not hold), and it goes with the failure.
    await indexPersonalAccessToken(env.OAUTH_KV, { hash, userId: session.sub, id, expiresAt });
    try {
      await this.#land(session.sub, {
        type: "events.iterate.com/account/personal-access-token-minted",
        idempotencyKey: `account/personal-access-token-minted/${id}`,
        payload: {
          id,
          name: data.name,
          hash,
          email: session.email,
          projects,
          expiresAt,
          device,
          mintedBy: session.grant.grantId,
        } satisfies PersonalAccessTokenMinted,
      });
    } catch (error) {
      await this.#unindex(session.sub, id, { hash });
      throw error;
    }
    return { id, token, expiresAt };
  }

  /** A device's client metadata document, for its name and logo in the list. */
  async #deviceClient(clientId: string) {
    try {
      return await oauthHelpers(this.#env, this.#addresses).lookupClient(clientId);
    } catch (error) {
      if (!(error instanceof CimdFetchError)) throw error;
      throw codedError(
        "INVALID_INPUT",
        "The device's OAuth metadata could not be loaded. Try preparing the device again.",
        { clientId, detail: error.detail },
      );
    }
  }
}
