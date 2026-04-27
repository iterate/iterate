/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import type { InitializeMembers, NamedInit } from "./initialize.ts";

type Constructor<T = object> = abstract new (...args: any[]) => T;

type DurableObjectConstructor<Env, Members = object> = abstract new (
  ...args: any[]
) => DurableObject<Env> & Members;

export type ExternalListingRecord<InitParams extends NamedInit> = {
  class: string;
  name: string;
  id: string;
  initParams: InitParams;
  createdAt: string;
  lastStartedAt: string;
};

export type ExternalListingMembers<InitParams extends NamedInit> = {
  getExternalListing(): Promise<ExternalListingRecord<InitParams> | undefined>;
};

export type WithExternalListingResult<
  TBase extends Constructor,
  InitParams extends NamedInit,
  Env,
> = TBase &
  Constructor<ExternalListingMembers<InitParams>> &
  (abstract new <FinalEnv extends Env>(
    ctx: DurableObjectState,
    env: FinalEnv,
  ) => DurableObject<FinalEnv> &
    InitializeMembers<InitParams> &
    ExternalListingMembers<InitParams>);

/**
 * Best-effort D1 listing for initialized Durable Objects.
 *
 * The D1 dependency is intentionally an explicit function instead of a mixin
 * that mutates the class' generic Env constraint. That keeps composition easy
 * to explain: the user's `getDatabase(env)` function is where TypeScript checks
 * the binding exists.
 *
 * The returned constructor is still generic, like Cloudflare's own mixin
 * pattern. The only constraint it adds is `FinalEnv extends Env`, where `Env`
 * is the explicit lower-bound selected by the `getDatabase(env)` callback.
 * That preserves `class Room extends ListedRoomBase<Env>` while still making
 * the D1 requirement visible at the composition site.
 */
export function withExternalListing<InitParams extends NamedInit, Env>(options: {
  className: string;
  getDatabase(env: Env): D1Database;
}) {
  return function <TBase extends DurableObjectConstructor<Env, InitializeMembers<InitParams>>>(
    Base: TBase,
  ): WithExternalListingResult<TBase, InitParams, Env> {
    abstract class ExternalListingMixin extends Base implements ExternalListingMembers<InitParams> {
      constructor(...args: any[]) {
        super(...args);

        const existing = tryGetInitializedParams(this);
        if (existing !== undefined) {
          this.scheduleExternalListingUpsert(existing);
        }
      }

      async initialize(params: InitParams) {
        const initialized = await super.initialize(params);

        this.scheduleExternalListingUpsert(initialized);

        return initialized;
      }

      async getExternalListing() {
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
            .bind(options.className, this.assertInitialized().name)
            .first();
        } catch (error) {
          if (isMissingExternalListingTableError(error)) {
            return undefined;
          }

          throw error;
        }

        if (row === null) {
          return undefined;
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

      private scheduleExternalListingUpsert(params: InitParams) {
        this.ctx.waitUntil(
          upsertExternalListing({
            db: options.getDatabase(this.env),
            className: options.className,
            id: this.ctx.id.toString(),
            params,
          }).catch((error: unknown) => {
            console.error("[withExternalListing] failed to upsert listing", error);
          }),
        );
      }
    }

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
    if (error instanceof Error && error.name === "NotInitializedError") {
      return undefined;
    }

    throw error;
  }
}

function isMissingExternalListingTableError(error: unknown) {
  return error instanceof Error && error.message.includes("no such table: mixin_external_listing");
}
