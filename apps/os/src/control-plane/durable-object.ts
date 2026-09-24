// src/control-plane/durable-object.ts — THE CONTROL PLANE: the `CONTROL_PLANE` singleton Durable
// Object (getByName("global")), plain methods over its database (catalog.ts, a normal DO with SQLite,
// not D1) and over the OAuth provider's grants (oauth-grants.ts, which need a read that sees the last
// write). A read is a query; a write is the database's synchronous block wrapped in one transaction,
// so a refusal partway leaves nothing. Reached by BINDING, not hosted as a facet of any context (so
// nothing else can host it): control-plane/edge.ts is the worker's typed client. It touches no other
// context — the session (session.ts) appends a project's saga request and an entity's activity to
// its own stream after the write; the database is only the index. The one thing it writes outside
// its database: the LAST-KNOWN COPIES of projects and hostnames in `OAUTH_KV`, which a project host's
// admission reads only when this object fails it (last-known-project.ts).
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import type { OrganizationRole } from "../organization/contract.ts";
import { type Caller, ControlPlaneDatabase, type ProjectRecord } from "./catalog.ts";
import type { IdentityProvider } from "./contract.ts";
import { lastKnownKey } from "./last-known-project.ts";
import { OAuthGrantTable } from "./oauth-grants.ts";

/** KV's clock: epoch seconds. */
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Where the one-time backfill of the copies (`alarm`) stands, in this object's own storage: the
 *  last project id it wrote, or `done`. */
const BACKFILL_KEY = "last-known-backfill";

export class ControlPlaneDurableObject extends DurableObject<Pick<Env, "OAUTH_KV">> {
  readonly #db = new ControlPlaneDatabase(this.ctx.storage.sql);
  /** The OAuth provider's grants (oauth-grants.ts), read and written through oauth-store.ts. */
  readonly #grants = new OAuthGrantTable(this.ctx.storage.sql);
  /** The hostname copies' writes, one after another (`#hostnameTurn`). */
  #hostnameWrites: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Pick<Env, "OAUTH_KV">) {
    super(ctx, env);
    if (ctx.storage.kv.get(BACKFILL_KEY) !== "done") void ctx.storage.setAlarm(Date.now());
  }

  /** THE ONE-TIME BACKFILL of the copies, for the rows written before copies were: every hostname's,
   *  then every project's by id, 200 projects (400 keys) an alarm — KV allows a Worker invocation
   *  1,000 operations (https://developers.cloudflare.com/kv/platform/limits/) — from where the
   *  last alarm stopped. A write that fails fails the alarm, which the runtime retries. */
  override async alarm() {
    const after = this.ctx.storage.kv.get<string>(BACKFILL_KEY);
    if (after === "done") return;
    if (!after) for (const hostname of this.#db.hostnames()) await this.#copyHostname(hostname);
    const page = this.#db.projectsAfter(after || "", 200);
    await Promise.all(page.map((project) => this.#copyProject(project)));
    this.ctx.storage.kv.put(BACKFILL_KEY, page.length < 200 ? "done" : page.at(-1)!.id);
    if (page.length === 200) await this.ctx.storage.setAlarm(Date.now());
  }

  /** A write — the database's synchronous check-and-insert — in one transaction: it stands whole or
   *  a refusal leaves nothing. */
  #write<T>(write: () => T): T {
    return this.ctx.storage.transactionSync(write);
  }

  user(ref: string) {
    return this.#db.user(ref);
  }
  users() {
    return this.#db.users();
  }
  identity(provider: IdentityProvider, subject: string) {
    return this.#db.identity(provider, subject);
  }
  organization(organizationId: string) {
    return this.#db.organization(organizationId);
  }
  organizations() {
    return this.#db.organizations();
  }
  members(organizationId: string) {
    return this.#db.members(organizationId);
  }
  project(ref: string) {
    return this.#db.project(ref);
  }
  projects() {
    return this.#db.projects();
  }
  accessibleTo(userId: string) {
    return this.#db.accessibleTo(userId);
  }
  projectByHostname(hostnames: readonly string[]) {
    return this.#db.projectByHostname(hostnames);
  }
  invitation(tokenHash: string, userId: string | null) {
    return this.#db.invitation(tokenHash, userId, Date.now());
  }

  createUser(input: { email: string }) {
    return this.#write(() => this.#db.createUser(input));
  }
  linkIdentity(input: { provider: IdentityProvider; subject: string; email: string }) {
    return this.#write(() => this.#db.linkIdentity(input));
  }
  createOrganization(caller: Caller, input: { name: string; ownerId?: string }) {
    return this.#write(() => this.#db.createOrganization(caller, input));
  }
  renameOrganization(caller: Caller, organizationId: string, name: string) {
    return this.#write(() => this.#db.renameOrganization(caller, organizationId, name));
  }
  deleteOrganization(caller: Caller, organizationId: string) {
    return this.#write(() => this.#db.deleteOrganization(caller, organizationId));
  }
  addMember(
    caller: Caller,
    organizationId: string,
    input: { userId: string; role: OrganizationRole },
  ) {
    return this.#write(() => this.#db.addMember(caller, organizationId, input));
  }
  removeMember(caller: Caller, organizationId: string, input: { userId: string }) {
    return this.#write(() => this.#db.removeMember(caller, organizationId, input));
  }
  createInvitation(
    caller: Caller,
    organizationId: string,
    input: { tokenHash: string; role: OrganizationRole; emailHint?: string; expiresAt: number },
  ) {
    return this.#write(() => this.#db.createInvitation(caller, organizationId, input, Date.now()));
  }
  revokeInvitation(caller: Caller, organizationId: string, invitationId: string) {
    return this.#write(() =>
      this.#db.revokeInvitation(caller, organizationId, invitationId, Date.now()),
    );
  }
  acceptInvitation(caller: Caller, tokenHash: string) {
    return this.#write(() => this.#db.acceptInvitation(caller, tokenHash, Date.now()));
  }
  /** The project's copies are written off the creation's path: a row never changes, and one that
   *  failed to land only means no copy (a 503 during an outage). */
  createProject(
    caller: Caller,
    input: { project: string; organizationId?: string; restoreProjectId?: string },
  ) {
    const project = this.#write(() => this.#db.createProject(caller, input));
    void this.#copyProject(project).catch((error: unknown) => copyUnwritten(project.slug, error));
    return project;
  }

  /** The claim, then the hostname's copy; a copy that failed to land is no copy. */
  async claimHostname(projectId: string, hostname: string) {
    this.#write(() => this.#db.claimHostname(projectId, hostname));
    await this.#copyHostname(hostname).catch((error: unknown) => copyUnwritten(hostname, error));
  }
  /** The copy is deleted BEFORE the row, in one turn, so a copy never outlives its claim: a delete
   *  that fails throws, and the hostname's processor asks again (project/processor.ts). Another
   *  project's claim, or none, is left alone. */
  releaseHostname(projectId: string, hostname: string) {
    return this.#hostnameTurn(async () => {
      if (this.#db.projectByHostname([hostname])?.project.id !== projectId) return;
      await this.env.OAUTH_KV.delete(lastKnownKey("hostname", hostname));
      this.#write(() => this.#db.releaseHostname(projectId, hostname));
    });
  }

  /** `project`'s copies, under its slug and its id (a project's own hostname names it by id). */
  async #copyProject(project: ProjectRecord) {
    const row = JSON.stringify(project);
    await Promise.all([
      this.env.OAUTH_KV.put(lastKnownKey("project", project.slug), row),
      this.env.OAUTH_KV.put(lastKnownKey("project", project.id), row),
    ]);
  }
  /** `hostname`'s copy as the catalog holds it at the write's turn: the row of the project holding
   *  it, or none (deleted). */
  #copyHostname(hostname: string) {
    return this.#hostnameTurn(async () => {
      const key = lastKnownKey("hostname", hostname);
      const found = this.#db.projectByHostname([hostname]);
      await (found
        ? this.env.OAUTH_KV.put(key, JSON.stringify(found.project))
        : this.env.OAUTH_KV.delete(key));
    });
  }
  /** `write` after every hostname copy write before it, so a hostname's last write is what the
   *  catalog held last — a backfill's in flight never lands after a release's delete. */
  #hostnameTurn(write: () => Promise<void>) {
    const turn = this.#hostnameWrites.then(write);
    this.#hostnameWrites = turn.catch(() => {});
    return turn;
  }

  oauthGrant(key: string) {
    return this.#grants.get(key, nowSeconds());
  }
  listOAuthGrants(prefix: string, options: { cursor?: string; limit?: number }) {
    return this.#grants.list(prefix, options, nowSeconds());
  }
  putOAuthGrant(key: string, value: string, expiresAt: number | null) {
    this.#write(() => this.#grants.put(key, value, expiresAt, nowSeconds()));
  }
  deleteOAuthGrant(key: string) {
    this.#grants.delete(key);
  }
}

/** A copy the control plane failed to write: none stands in for it during an outage (a 503, as
 *  before copies). Never a platform-failure page of its own. */
function copyUnwritten(name: string, error: unknown) {
  console.warn({ event: "control-plane.last-known-copy-unwritten", name, message: String(error) });
}
