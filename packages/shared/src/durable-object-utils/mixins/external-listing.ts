/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import type { InitializeMembers, NamedInit } from "./initialize.ts";

type Constructor<T = object> = abstract new (...args: any[]) => T;

type DurableObjectConstructor<T = object> = abstract new (...args: any[]) => DurableObject & T;

type EnvWithD1<BindingName extends string> = Record<BindingName, D1Database>;

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
  TBase extends DurableObjectConstructor,
  InitParams extends NamedInit,
  BindingName extends string,
> = TBase &
  Constructor<ExternalListingMembers<InitParams>> &
  (abstract new <Env extends EnvWithD1<BindingName>>(
    ctx: DurableObjectState,
    env: Env,
  ) => DurableObject<Env> & InitializeMembers<InitParams> & ExternalListingMembers<InitParams>);

export function withExternalListing<
  InitParams extends NamedInit,
  BindingName extends string,
>(options: { d1Binding: BindingName; className: string }) {
  return function <TBase extends DurableObjectConstructor<InitializeMembers<InitParams>>>(
    Base: TBase,
  ): WithExternalListingResult<TBase, InitParams, BindingName> {
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
        const row = await getD1(this.env, options.d1Binding)
          .prepare(
            `SELECT class, name, id, init_params_json, created_at, last_started_at
             FROM mixin_external_listing
             WHERE class = ? AND name = ?
             LIMIT 1`,
          )
          .bind(options.className, this.assertInitialized().name)
          .first<{
            class: string;
            name: string;
            id: string;
            init_params_json: string;
            created_at: string;
            last_started_at: string;
          }>();

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
            db: getD1(this.env, options.d1Binding),
            className: options.className,
            id: this.ctx.id.toString(),
            params,
          }).catch((error: unknown) => {
            console.error("[withExternalListing] failed to upsert listing", error);
          }),
        );
      }
    }

    return ExternalListingMixin as unknown as WithExternalListingResult<
      TBase,
      InitParams,
      BindingName
    >;
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
    params.db.prepare(`CREATE TABLE IF NOT EXISTS mixin_external_listing (
      class TEXT NOT NULL,
      name TEXT NOT NULL,
      id TEXT NOT NULL,
      init_params_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_started_at TEXT NOT NULL,
      PRIMARY KEY (class, name)
    )`),
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

function getD1<BindingName extends string>(env: object, bindingName: BindingName) {
  return (env as Record<BindingName, D1Database>)[bindingName];
}
