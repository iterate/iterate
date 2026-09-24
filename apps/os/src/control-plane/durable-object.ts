// src/control-plane/durable-object.ts — THE CONTROL PLANE: the `CONTROL_PLANE` singleton Durable
// Object (getByName("global")), plain methods over its database (catalog.ts, a normal DO with SQLite,
// not D1) and over the OAuth provider's grants (oauth-grants.ts, which need a read that sees the last
// write). A read is a query; a write is the database's synchronous block wrapped in one transaction,
// so a refusal partway leaves nothing. Reached by BINDING, not hosted as a facet of any context (so
// nothing else can host it): control-plane/edge.ts is the worker's typed client. It touches no other
// context — the session (session.ts) appends a project's saga request and an entity's activity to
// its own stream after the write; the database is only the index.
import { DurableObject } from "cloudflare:workers";
import type { OrganizationRole } from "../organization/contract.ts";
import { type Caller, ControlPlaneDatabase } from "./catalog.ts";
import type { IdentityProvider } from "./contract.ts";
import { OAuthGrantTable } from "./oauth-grants.ts";

/** KV's clock: epoch seconds. */
const nowSeconds = () => Math.floor(Date.now() / 1000);

export class ControlPlaneDurableObject extends DurableObject {
  readonly #db = new ControlPlaneDatabase(this.ctx.storage.sql);
  /** The OAuth provider's grants (oauth-grants.ts), read and written through oauth-store.ts. */
  readonly #grants = new OAuthGrantTable(this.ctx.storage.sql);

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
  createProject(
    caller: Caller,
    input: { project: string; organizationId?: string; restoreProjectId?: string },
  ) {
    return this.#write(() => this.#db.createProject(caller, input));
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
