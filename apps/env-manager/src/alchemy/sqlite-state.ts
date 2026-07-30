import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { STATE_STORE_VERSION } from "alchemy/State/HttpStateApi";
import { State, StateStoreError, type PersistedState, type StateService } from "alchemy/State";
import { encodeState, reviveState } from "alchemy/State/StateEncoding";

type TextRow = { value: string };

function stateStoreFailure(operation: string, cause: unknown): StateStoreError {
  return new StateStoreError({
    message: `Durable Object Alchemy state ${operation} failed.`,
    cause: cause instanceof Error ? cause : new Error(String(cause)),
  });
}

function attempt<A>(operation: string, evaluate: () => A): Effect.Effect<A, StateStoreError> {
  return Effect.try({
    try: evaluate,
    catch: (cause) => stateStoreFailure(operation, cause),
  });
}

function decode(value: string): unknown {
  return JSON.parse(value, reviveState);
}

function encode(value: unknown): string {
  return JSON.stringify(encodeState(value));
}

export function makeSqliteAlchemyState(sql: SqlStorage): Layer.Layer<State> {
  sql.exec(`
    create table if not exists alchemy_resources (
      stack text not null,
      stage text not null,
      fqn text not null,
      value text not null,
      primary key (stack, stage, fqn)
    );
    create table if not exists alchemy_outputs (
      stack text not null,
      stage text not null,
      value text not null,
      primary key (stack, stage)
    );
  `);

  const service: StateService = {
    id: "durable-object-sqlite",
    getVersion: () => Effect.succeed(STATE_STORE_VERSION),
    listStacks: () =>
      attempt("listStacks", () =>
        sql
          .exec<{ stack: string }>(
            `select distinct stack from (
               select stack from alchemy_resources
               union all
               select stack from alchemy_outputs
             ) order by stack`,
          )
          .toArray()
          .map((row) => row.stack),
      ),
    listStages: (stack) =>
      attempt("listStages", () =>
        sql
          .exec<{ stage: string }>(
            `select distinct stage from (
               select stage from alchemy_resources where stack = ?
               union all
               select stage from alchemy_outputs where stack = ?
             ) order by stage`,
            stack,
            stack,
          )
          .toArray()
          .map((row) => row.stage),
      ),
    get: (request) =>
      attempt("get", () => {
        const row = sql
          .exec<TextRow>(
            "select value from alchemy_resources where stack = ? and stage = ? and fqn = ?",
            request.stack,
            request.stage,
            request.fqn,
          )
          .toArray()[0];
        return row === undefined ? undefined : (decode(row.value) as PersistedState);
      }),
    getReplacedResources: (request) =>
      attempt("getReplacedResources", () =>
        sql
          .exec<TextRow>(
            "select value from alchemy_resources where stack = ? and stage = ?",
            request.stack,
            request.stage,
          )
          .toArray()
          .map((row) => decode(row.value) as PersistedState)
          .filter((state) => state.status === "replaced"),
      ),
    set: (request) =>
      attempt("set", () => {
        sql.exec(
          `insert into alchemy_resources (stack, stage, fqn, value)
           values (?, ?, ?, ?)
           on conflict (stack, stage, fqn) do update set value = excluded.value`,
          request.stack,
          request.stage,
          request.fqn,
          encode(request.value),
        );
        return request.value;
      }),
    delete: (request) =>
      attempt("delete", () => {
        sql.exec(
          "delete from alchemy_resources where stack = ? and stage = ? and fqn = ?",
          request.stack,
          request.stage,
          request.fqn,
        );
      }),
    deleteStack: ({ stack, stage }) =>
      attempt("deleteStack", () => {
        if (stage === undefined) {
          sql.exec("delete from alchemy_resources where stack = ?", stack);
          sql.exec("delete from alchemy_outputs where stack = ?", stack);
          return;
        }
        sql.exec("delete from alchemy_resources where stack = ? and stage = ?", stack, stage);
        sql.exec("delete from alchemy_outputs where stack = ? and stage = ?", stack, stage);
      }),
    list: (request) =>
      attempt("list", () =>
        sql
          .exec<{ fqn: string }>(
            "select fqn from alchemy_resources where stack = ? and stage = ? order by fqn",
            request.stack,
            request.stage,
          )
          .toArray()
          .map((row) => row.fqn),
      ),
    getOutput: (request) =>
      attempt("getOutput", () => {
        const row = sql
          .exec<TextRow>(
            "select value from alchemy_outputs where stack = ? and stage = ?",
            request.stack,
            request.stage,
          )
          .toArray()[0];
        return row === undefined ? undefined : decode(row.value);
      }),
    setOutput: (request) =>
      attempt("setOutput", () => {
        sql.exec(
          `insert into alchemy_outputs (stack, stage, value)
           values (?, ?, ?)
           on conflict (stack, stage) do update set value = excluded.value`,
          request.stack,
          request.stage,
          encode(request.value),
        );
        return request.value;
      }),
  };

  return Layer.succeed(State, Effect.succeed(service));
}
