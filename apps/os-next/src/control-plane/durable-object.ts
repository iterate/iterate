// src/control-plane/durable-object.ts — THE CONTROL PLANE: the `control-plane` facet on the context
// at `global:/`, one Durable Object with plain methods over its catalog (catalog.ts). A read is a
// query. A write is the catalog's synchronous block — the check and the insert together — and then
// the delivery of the facts it owes: the organization's record and the member's account (the folds
// the dash reads through live state, src/organization/ and src/account/) and the root's own log
// (contract.ts, the after-the-fact record), and a project's own root, whose saga creates it
// (src/project/processor.ts seeds its config repo from there). Awaiting another
// context never blocks this object — other calls run meanwhile — so the only serial part of any
// command is the microseconds of its SQL. Hosted from `ctx.exports` (first-party-facets.ts) and
// reached by the edge as `itx.facets.get("control-plane").<method>(…)` (edge.ts), with no processor
// row: nothing is delivered to it. Other contexts are reached BY IDENTITY over the worker's own
// binding — holding the binding is the trust.
import { DurableObject } from "cloudflare:workers";
import { reportIssue } from "iterate/next/lib";
import type { ItxExpression } from "iterate/next/expression";
import type { Caller } from "iterate/next/principal";
import { DurableObjectNameCodec } from "../iterate-context.ts";
import type { IterateContextDurableObject } from "../iterate-context-durable-object.ts";
import type { OrganizationRole } from "../organization/contract.ts";
import { type Asker, Catalog, type OutboxRow, type OwedContext } from "./catalog.ts";
import type { IdentityProvider } from "./contract.ts";

type Env = { ITERATE_CONTEXT: DurableObjectNamespace<IterateContextDurableObject> };

export class ControlPlaneDurableObject extends DurableObject<Env> {
  readonly #catalog = new Catalog(this.ctx.storage.sql);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // what the last incarnation left owed (a crash between a write and its delivery) goes first
    for (const context of this.#catalog.owed(0)) void this.#deliver(context);
  }

  // ── the reads ──

  user(ref: string) {
    return this.#catalog.user(ref);
  }
  users() {
    return this.#catalog.users();
  }
  identity(provider: IdentityProvider, subject: string) {
    return this.#catalog.identity(provider, subject);
  }
  organization(orgId: string) {
    return this.#catalog.organization(orgId);
  }
  organizations() {
    return this.#catalog.organizations();
  }
  members(orgId: string) {
    return this.#catalog.members(orgId);
  }
  project(ref: string) {
    return this.#catalog.project(ref);
  }
  projects() {
    return this.#catalog.projects();
  }
  reach(userId: string) {
    return this.#catalog.reach(userId);
  }

  // ── the writes ──

  createUser(asker: Asker, input: { email: string; id?: string }) {
    return this.#write(() => this.#catalog.createUser(asker, input));
  }
  linkIdentity(
    asker: Asker,
    input: { provider: IdentityProvider; subject: string; email: string },
  ) {
    return this.#write(() => this.#catalog.linkIdentity(asker, input));
  }
  createOrganization(asker: Asker, input: { name: string; id?: string; ownerId?: string }) {
    return this.#write(() => this.#catalog.createOrganization(asker, input));
  }
  renameOrganization(asker: Asker, orgId: string, name: string) {
    return this.#write(() => this.#catalog.renameOrganization(asker, orgId, name));
  }
  deleteOrganization(asker: Asker, orgId: string) {
    return this.#write(() => this.#catalog.deleteOrganization(asker, orgId));
  }
  addMember(asker: Asker, orgId: string, input: { userId: string; role: OrganizationRole }) {
    return this.#write(() => this.#catalog.addMember(asker, orgId, input));
  }
  removeMember(asker: Asker, orgId: string, input: { userId: string }) {
    return this.#write(() => this.#catalog.removeMember(asker, orgId, input));
  }
  createProject(
    asker: Asker,
    input: {
      project: string;
      orgId?: string;
      restoreProjectId?: string;
      configRepoTemplate?: string;
    },
  ) {
    return this.#write(() => this.#catalog.createProject(asker, input));
  }

  // ── after the write: the facts it owes, delivered ──

  /** The delivery in flight per context, by its name: facts to one context land in the order they
   *  were owed. */
  readonly #deliveries = new Map<string, Promise<void>>();
  /** How many deliveries to a context have failed in a row — the backoff of its next retry. */
  readonly #failures = new Map<string, number>();

  /** The write — one synchronous block — then the delivery of the facts it owes, awaited so the
   *  folds read what the catalog says. The write stands whatever the delivery does: a failed one is
   *  retried in the background until it lands (#deliver), so the call never fails after the fact —
   *  a client retrying it would make a second organization. */
  async #write<T>(write: () => T): Promise<T> {
    const head = this.#catalog.outboxHead();
    // one transaction: the rows and the facts they owe commit together, or a refusal leaves nothing
    const answer = this.ctx.storage.transactionSync(write);
    await Promise.all(this.#catalog.owed(head).map((context) => this.#deliver(context)));
    return answer;
  }

  /** One delivery to a context, after the one before it; never rejects. A failure is reported and
   *  the context tried again — 2 s, 4 s, … up to a minute apart — until what it is owed lands. */
  #deliver(context: OwedContext): Promise<void> {
    const name = DurableObjectNameCodec.stringify(context);
    const delivery = (this.#deliveries.get(name) ?? Promise.resolve())
      .then(() => this.#flush(context, name))
      .then(
        () => void this.#failures.delete(name),
        (error: unknown) => {
          const failures = (this.#failures.get(name) ?? 0) + 1;
          this.#failures.set(name, failures);
          reportIssue("control-plane.deliver", error, { context: name, failures });
          setTimeout(() => void this.#deliver(context), Math.min(60_000, 1_000 * 2 ** failures));
        },
      );
    this.#deliveries.set(name, delivery);
    return delivery;
  }

  /** Everything owed to one context, oldest first: its processor row enabled, and each run of facts
   *  by one asker appended in one call under that asker, keyed by the outbox row — a delivery
   *  repeated after a failure lands nothing twice. */
  async #flush(owed: OwedContext, name: string): Promise<void> {
    const rows = this.#catalog.outbox(owed);
    if (!rows.length) return;
    const context = this.env.ITERATE_CONTEXT.getByName(name);
    const caller = (row: OutboxRow): Caller => JSON.parse(row.asker) as Asker;
    const processor = rows.find((row) => row.processor)?.processor;
    const enabled =
      processor &&
      this.#invoke(context, ["itx", "processors", ["enable", processor]], caller(rows[0]!));
    for (let start = 0; start < rows.length; ) {
      let end = start + 1;
      while (end < rows.length && rows[end]!.asker === rows[start]!.asker) end++;
      const run = rows.slice(start, end);
      const events = run.map((row) => ({
        ...JSON.parse(row.event),
        idempotencyKey: `control-plane/${row.id}`,
      }));
      await this.#invoke(context, ["itx", ["append", ...events]], caller(run[0]!));
      start = end;
    }
    // delivered only once the processor's row is enabled too: a failed enable keeps the rows owed,
    // and the retry appends nothing twice (keyed) and enables again. The order does not matter to
    // the processor: an enabled one folds the log from its start.
    await enabled;
    this.#catalog.delivered(rows.map((row) => row.id));
  }

  /** ONE call on a context, under `caller`; its answer (the enabled row, the appended events) is
   *  not needed. */
  async #invoke(
    context: DurableObjectStub<IterateContextDurableObject>,
    expression: ItxExpression,
    caller: Caller,
  ): Promise<void> {
    await context.invoke(expression, [], caller);
  }
}
