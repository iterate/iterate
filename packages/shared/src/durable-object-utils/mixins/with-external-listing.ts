/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import type { InitializeMembers, NamedInit } from "./with-initialize.ts";
import type { Constructor, DurableObjectConstructor } from "./mixin-types.ts";

export type ExternalListingRecord<InitParams extends NamedInit> = {
  class: string;
  name: string;
  id: string;
  initParams: InitParams;
  createdAt: string;
  lastStartedAt: string;
};

export type ExternalListingMembers<InitParams extends NamedInit> = {
  /**
   * Returns the D1 mirror row for this Durable Object, or `null` when no row is
   * available yet.
   *
   * `null` covers three ordinary states: the object has not been initialized,
   * the background D1 write has not run yet, or the mixin-owned table has not
   * been created yet.
   */
  getExternalListing(): Promise<ExternalListingRecord<InitParams> | null>;
};

export type WithExternalListingResult<
  TBase extends Constructor,
  InitParams extends NamedInit,
  Env,
> = TBase &
  // This non-generic constructor keeps the added method visible on subclasses.
  // The explicit generic constructor below keeps `Base<FinalEnv>` valid and
  // carries the D1 Env lower-bound.
  Constructor<ExternalListingMembers<InitParams>> &
  // Preserve the Cloudflare-style `class Room extends Base<Env>` ergonomics
  // while also carrying the D1 requirement forward.
  //
  // `Env` here is not necessarily the final worker env. It is the smallest env
  // shape required by `getDatabase(env)`, for example:
  //
  //   type NeedsListings = { DO_LISTINGS: D1Database };
  //   const Base = withExternalListing<RoomInit, NeedsListings>(...)(RoomBase);
  //
  // Then this works because FullEnv has at least DO_LISTINGS:
  //
  //   type FullEnv = NeedsListings & { OTHER: string };
  //   class Room extends Base<FullEnv> {}
  //
  // And this fails because MissingEnv does not satisfy the lower bound:
  //
  //   class Broken extends Base<{ OTHER: string }> {}
  (abstract new <FinalEnv extends Env>(
    ctx: DurableObjectState,
    env: FinalEnv,
  ) => DurableObject<FinalEnv> &
    InitializeMembers<InitParams> &
    ExternalListingMembers<InitParams>);

/**
 * Best-effort D1 listing for initialized Durable Objects.
 *
 * Listing writes are scheduled after `initialize()` with `ctx.waitUntil()`:
 * initialization succeeds even if D1 is unavailable, and callers may
 * temporarily observe no listing after `initialize()` returns. This mixin is
 * for discoverability/debug indexes, not source-of-truth state.
 *
 * The constructor intentionally does not write to D1. Our main helper,
 * `getInitializedDoStub()`, always calls `initialize()`, including for objects
 * that were already initialized, so constructor writes would duplicate the
 * common-path listing update on every wake-up.
 *
 * `getDatabase(env)` is the explicit D1 dependency. Its parameter type is the
 * minimum Env this mixin requires.
 */
export function withExternalListing<InitParams extends NamedInit, Env>(options: {
  className: string;
  getDatabase(env: Env): D1Database;
}) {
  return function <TBase extends DurableObjectConstructor<Env, InitializeMembers<InitParams>>>(
    Base: TBase,
  ): WithExternalListingResult<TBase, InitParams, Env> {
    abstract class ExternalListingMixin extends Base implements ExternalListingMembers<InitParams> {
      async initialize(params: InitParams) {
        const initialized = await super.initialize(params);

        // This runs for first initialization and for idempotent re-initializing
        // calls. That matches the intended entry point: callers get a stub via
        // `getInitializedDoStub()`, which always calls `initialize()` before
        // handing the stub back.
        this.scheduleExternalListingUpsert(initialized);

        return initialized;
      }

      /**
       * Reads the external D1 mirror without initializing the object.
       */
      async getExternalListing() {
        // Listing is an optional mirror of initialize state. If the object has
        // not been initialized, there is intentionally no external row to read.
        const initialized = tryGetInitializedParams(this);
        if (initialized === undefined) {
          return null;
        }

        let row: {
          class: string;
          name: string;
          id: string;
          init_params_json: string;
          created_at: string;
          last_started_at: string;
        } | null;

        try {
          row = await options
            .getDatabase(this.env)
            .prepare(
              `SELECT class, name, id, init_params_json, created_at, last_started_at
               FROM mixin_external_listing
               WHERE class = ? AND name = ?
               LIMIT 1`,
            )
            .bind(options.className, initialized.name)
            .first();
        } catch (error) {
          // The table is created by the same best-effort write that creates the
          // row. A read can win that race, so missing table means "not listed"
          // rather than "this Durable Object is broken".
          if (isMissingExternalListingTableError(error)) {
            return null;
          }

          throw error;
        }

        if (row === null) {
          return null;
        }

        return {
          class: row.class,
          name: row.name,
          id: row.id,
          initParams: JSON.parse(row.init_params_json) as InitParams,
          createdAt: row.created_at,
          lastStartedAt: row.last_started_at,
        };
      }

      /**
       * Fire-and-log mirror update.
       *
       * `ctx.waitUntil()` keeps the invocation alive for the D1 write, but the
       * caller does not wait for it and failures must not roll back Durable
       * Object initialization.
       */
      private scheduleExternalListingUpsert(params: InitParams) {
        // External listing must not make initialization fail. It is a discovery
        // index, not source-of-truth state, so failures are logged and the DO's
        // local initialization still succeeds.
        this.ctx.waitUntil(
          Promise.resolve()
            .then(() =>
              upsertExternalListing({
                db: options.getDatabase(this.env),
                className: options.className,
                id: this.ctx.id.toString(),
                params,
              }),
            )
            .catch((error: unknown) => {
              console.error("[withExternalListing] failed to upsert listing", error);
            }),
        );
      }
    }

    // TypeScript cannot infer that this class expression preserves Base's
    // static/protected side while adding a generic `FinalEnv extends Env`
    // constructor surface. The implementation above provides the runtime
    // methods; this cast publishes that composed class shape.
    return ExternalListingMixin as unknown as WithExternalListingResult<TBase, InitParams, Env>;
  };
}

async function upsertExternalListing<InitParams extends NamedInit>(params: {
  db: D1Database;
  className: string;
  id: string;
  params: InitParams;
}) {
  const now = new Date().toISOString();

  // Idempotent bootstrap + upsert: every write can create the mixin-owned table,
  // then insert/update the `(class, name)` row. Constructors stay cheap because
  // this happens only after `initialize()`, inside waitUntil. `created_at`
  // remains the first insertion time; `last_started_at` moves on each helper
  // acquisition because `getInitializedDoStub()` always calls `initialize()`.
  await params.db.batch([
    params.db.prepare(CREATE_EXTERNAL_LISTING_TABLE_SQL),
    params.db
      .prepare(
        `INSERT INTO mixin_external_listing (
          class,
          name,
          id,
          init_params_json,
          created_at,
          last_started_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(class, name) DO UPDATE SET
          id = excluded.id,
          init_params_json = excluded.init_params_json,
          last_started_at = excluded.last_started_at`,
      )
      .bind(
        params.className,
        params.params.name,
        params.id,
        // The listing table is intentionally a simple external index. Init
        // params used with this mixin should be JSON-compatible; non-JSON
        // values fail the best-effort write and are logged by waitUntil.
        JSON.stringify(params.params),
        now,
        now,
      ),
  ]);
}

const CREATE_EXTERNAL_LISTING_TABLE_SQL = `CREATE TABLE IF NOT EXISTS mixin_external_listing (
      class TEXT NOT NULL,
      name TEXT NOT NULL,
      id TEXT NOT NULL,
      init_params_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_started_at TEXT NOT NULL,
      PRIMARY KEY (class, name)
    )`;

function tryGetInitializedParams<InitParams extends NamedInit>(
  instance: InitializeMembers<InitParams>,
) {
  try {
    return instance.assertInitialized();
  } catch (error) {
    // Avoid importing the concrete error class just for an instanceof check
    // across Worker module boundaries. The public error name is stable enough
    // for this internal "initialized or not" probe.
    if (error instanceof Error && error.name === "NotInitializedError") {
      return undefined;
    }

    throw error;
  }
}

function isMissingExternalListingTableError(error: unknown) {
  return error instanceof Error && error.message.includes("no such table: mixin_external_listing");
}
