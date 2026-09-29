// context/rule-snapshots.ts — ANOTHER CONTEXT'S RULE TABLE, AS THIS ISOLATE KNOWS IT, and THE
// FRESHNESS CONTRACT of every table a call resolves through. A snapshot carries the context's
// ROUTING too — its fetch routes and its ingress — which the edge serves a project's hosts from
// (worker.ts `serveProjectHost`), read and fenced as the rules are. Where a call runs is the resolver's
// (itx-expression-rewriting.ts `ItxExpressionResolver.invoke`); the tables its chain crosses are
// SNAPSHOTS: read from their owner (`IterateContextDurableObject.rulesSnapshot`), kept per isolate
// by the owner's Durable Object name, and used for SNAPSHOT_TTL_MS from when the read was SENT —
// checked after every wait for one, and again before a route assembled from several runs. Reads are
// lazy (only when a resolution needs the table), conditional on the version the isolate holds (an
// unchanged table answers its version alone) and single-flight per owner.
//
// A CONTEXT'S OWN TABLE: its Durable Object reads it live. Its loaded code, through the stateless
// entrypoint, reads it as a snapshot like any other table — and a call that snapshot refuses goes
// to the context, which decides it live, so the line after a `provide` calls what it provided.
//
// READ-YOUR-WRITES, with no clock shared between machines (the routing: every change waits):
//   • a write that only ADDS a new name answers its writer at once, and every other reader sees it
//     within SNAPSHOT_TTL_MS. A refusal a snapshot gives is cached like any answer, so code probing
//     a missing name on every event reads the owner once per SNAPSHOT_TTL_MS, never once per call;
//   • a write that REMOVES or CHANGES a name that already answered (a mask, a removal, a re-point, a
//     grant that shadows: itx-expression-rewriting.ts `rulesChangeNeedsCommitWait`) answers its
//     writer only once every snapshot of the old table has expired: the owner remembers the latest
//     moment a snapshot it served can still be used (its lease, measured on its own clock from when
//     it served, which is after the reader sent), takes it at the commit as the FENCE — stored in
//     the commit's write batch, so a repeat, a retry after a reset and the name re-added wait it
//     out too (`namesTakenAway`) — and answers
//     once it has passed: up to SNAPSHOT_TTL_MS. A snapshot served after the commit carries the new
//     table and is not waited for. So a narrowing holds for every reader, the context's own loaded
//     code included, once the write answers; code that runs while the write waits may still use
//     the old grant, for up to SNAPSHOT_TTL_MS.
// A stale snapshot can cost a hop to a context that now resolves the call elsewhere, never a stale
// answer from what lives there.

import type { ItxExpression } from "iterate/expression";
import { releaseRpcSessions } from "iterate/lib";
import { failureKind, ONCE_NOW, retryPlatformFailures } from "@iterate-com/shared/platform-retry";
import type { FetchRouteTable } from "../fetch-routes.ts";
import { unavailable, unavailableError } from "../unavailable.ts";
import type { ItxExpressionRewriteRule } from "./itx-expression-rewriting.ts";

/** How long a snapshot of another context's rule table may be used, from when its read was sent —
 *  the most a context's root is read per active isolate, and the longest a write that takes
 *  something away waits for its answer. */
export const SNAPSHOT_TTL_MS = 5_000;

/** What `rulesSnapshot(ifVersion)` answers: the table's version, and its rows unless the reader
 *  already holds that version. A row may carry a worker's whole source, at most
 *  REWRITE_RULE_TARGET_MAX_CHARS (itx-expression-rewriting.ts), which a reader needs to load it
 *  where the call is; an unchanged table answers its version alone. Over Workers RPC the stub's
 *  method answers `never` (workers-types' Rpc.Serializable does not reach expressions): a reader
 *  casts its answer to this. */
export type RulesSnapshotAnswer = {
  version: string;
  rules?: ItxExpressionRewriteRule[];
  routing?: SnapshotRouting;
};

/** Where a context sends its project's web requests (core state `fetchRoutes`, `ingressTarget`):
 *  a root's alone are ever read. */
export type SnapshotRouting = { fetchRoutes: FetchRouteTable; ingressTarget: ItxExpression | null };

/** A snapshot this isolate holds: the rows, their version, and when its read was sent. */
type HeldSnapshot = {
  version: string;
  rules: readonly ItxExpressionRewriteRule[];
  routing: SnapshotRouting;
  sentAt: number;
};

/** A snapshot as a resolution uses it: the rows, the routing, and the moment they may no longer be
 *  used. */
export type UsableSnapshot = {
  rules: readonly ItxExpressionRewriteRule[];
  routing: SnapshotRouting;
  expiresAt: number;
};

/** How many owners' snapshots one isolate keeps, the oldest read dropped first: an owner dropped is
 *  read again, unconditionally, the next time a call needs it. */
const MAX_HELD_SNAPSHOTS = 1_000;

/** How many reads one call makes of an owner whose snapshots arrive already expired (an owner
 *  slower than SNAPSHOT_TTL_MS to answer) before it is UNAVAILABLE. */
const MAX_READS_PER_CALL = 3;

/** One isolate's snapshots, by the owner's Durable Object name. `read` asks the owner. */
export class RuleSnapshotCache {
  readonly #held = new Map<string, HeldSnapshot>();
  readonly #reading = new Map<string, Promise<HeldSnapshot>>();
  readonly #now: () => number;
  readonly #maxEntries: number;

  constructor({ now = () => Date.now(), maxEntries = MAX_HELD_SNAPSHOTS } = {}) {
    this.#now = now;
    this.#maxEntries = maxEntries;
  }

  /** The owner's table, usable now: the one held while it lasts, else the read in flight, else a
   *  new read naming the version held. A snapshot is used only while it lasts, checked after every
   *  wait for one — a read in flight may answer after its lifetime. */
  async get(
    name: string,
    read: (ifVersion: string | undefined) => Promise<RulesSnapshotAnswer>,
  ): Promise<UsableSnapshot> {
    for (let reads = 0; reads < MAX_READS_PER_CALL; reads++) {
      const held = this.#held.get(name);
      if (held && this.#now() < held.sentAt + SNAPSHOT_TTL_MS) return usable(held);
      const snapshot = await (this.#reading.get(name) || this.#read(name, read, held));
      if (this.#now() < snapshot.sentAt + SNAPSHOT_TTL_MS) return usable(snapshot);
    }
    throw unavailableError(
      "overloaded",
      `the rule snapshot of ${name} arrived expired ${MAX_READS_PER_CALL} times: its owner answers slower than a snapshot lasts`,
    );
  }

  /** One read of the owner, shared by every call that needs it while it is in flight, and held —
   *  in place of the one before, the oldest held dropped past the cap. A read is idempotent: one a
   *  deploy's reset or a lost connection failed is made once more at once, and lasts from when the
   *  first was sent; a platform failure that stands is UNAVAILABLE. */
  #read(
    name: string,
    read: (ifVersion: string | undefined) => Promise<RulesSnapshotAnswer>,
    held: HeldSnapshot | undefined,
  ): Promise<HeldSnapshot> {
    const sentAt = this.#now();
    const answer = retryPlatformFailures(() => read(held?.version), {
      area: "rule-snapshot",
      schedule: ONCE_NOW,
      idempotent: true,
      kind: failureKind,
      describe: () => ({ name: "rulesSnapshot", context: name }),
    })
      .catch((error: unknown) => {
        throw unavailable(error);
      })
      .then((result): HeldSnapshot => {
        // KEPT AS A COPY: a Workers-RPC result holds its session — and the owner, resident —
        // until it is disposed (context/dispatch.ts `itxAnswerDetachedFromSession` says why), and
        // a snapshot is kept for its lifetime and after.
        const answered = structuredClone(result);
        releaseRpcSessions([result]);
        const unchanged = answered.version === held?.version ? held : undefined;
        const rules = answered.rules || unchanged?.rules;
        const routing = answered.routing || unchanged?.routing;
        if (!rules || !routing)
          throw new Error(
            `the rule snapshot of ${name} answered version ${answered.version} without its rows`,
          );
        const snapshot = { version: answered.version, rules, routing, sentAt };
        this.#held.delete(name);
        this.#held.set(name, snapshot);
        if (this.#held.size > this.#maxEntries) this.#held.delete(this.#held.keys().next().value!);
        return snapshot;
      })
      .finally(() => this.#reading.delete(name));
    this.#reading.set(name, answer);
    return answer;
  }
}

const usable = (snapshot: HeldSnapshot): UsableSnapshot => ({
  rules: snapshot.rules,
  routing: snapshot.routing,
  expiresAt: snapshot.sentAt + SNAPSHOT_TTL_MS,
});

/** THE ISOLATE'S snapshots: every context Durable Object and stateless entrypoint in this isolate
 *  shares them, so the root is read once per isolate per SNAPSHOT_TTL_MS however many contexts in
 *  it resolve through the root's table. */
export const ruleSnapshots = new RuleSnapshotCache();
