import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  State,
  StateStoreError,
  type PersistedState,
  type ReplacedResourceState,
  type StateService,
} from "alchemy/State";
import { STATE_STORE_VERSION } from "alchemy/State/HttpStateApi";
import { encodeState, reviveState } from "alchemy/State/StateEncoding";

type TextRow = { value: string };

// Resource FQNs are non-empty; the empty key keeps stack output in the same
// table so deleting a stack is one atomic SQL statement.
const STACK_OUTPUT_FQN = "";

function initializeAlchemyStateTable(sql: SqlStorage): void {
  sql.exec(`
    create table if not exists alchemy_state (
      stack text not null,
      stage text not null,
      fqn text not null,
      value text not null,
      primary key (stack, stage, fqn)
    )
  `);
}

export function readSqliteAlchemyOutput(
  storage: DurableObjectStorage,
  input: { stack: string; stage: string },
): unknown | undefined {
  const sql = storage.sql;
  initializeAlchemyStateTable(sql);
  const row = sql
    .exec<TextRow>(
      "select value from alchemy_state where stack = ? and stage = ? and fqn = ?",
      input.stack,
      input.stage,
      STACK_OUTPUT_FQN,
    )
    .toArray()[0];
  return row === undefined ? undefined : decode(row.value);
}

function attempt<A>(operation: string, evaluate: () => A): Effect.Effect<A, StateStoreError> {
  return Effect.try({
    try: evaluate,
    catch: (cause) =>
      new StateStoreError({
        message: `Durable Object Alchemy state ${operation} failed.`,
        cause: cause instanceof Error ? cause : new Error(String(cause)),
      }),
  });
}

function decode(value: string): unknown {
  return JSON.parse(value, reviveState);
}

function decodePersistedState(value: string): PersistedState {
  // This table is private to this StateService and every row is written by
  // encode below. Alchemy's own state stores trust the same codec boundary.
  return decode(value) as PersistedState;
}

export function makeSqliteAlchemyState(storage: DurableObjectStorage): Layer.Layer<State> {
  return Layer.effect(
    State,
    Effect.cached(
      Effect.sync(() => {
        const sql = storage.sql;
        initializeAlchemyStateTable(sql);

        const service: StateService = {
          id: "durable-object-sqlite",
          getVersion: () => Effect.succeed(STATE_STORE_VERSION),
          listStacks: () =>
            attempt("listStacks", () =>
              sql
                .exec<{ stack: string }>("select distinct stack from alchemy_state order by stack")
                .toArray()
                .map(({ stack }) => stack),
            ),
          listStages: (stack) =>
            attempt("listStages", () =>
              sql
                .exec<{ stage: string }>(
                  "select distinct stage from alchemy_state where stack = ? order by stage",
                  stack,
                )
                .toArray()
                .map(({ stage }) => stage),
            ),
          get: ({ stack, stage, fqn }) =>
            attempt("get", () => {
              const row = sql
                .exec<TextRow>(
                  "select value from alchemy_state where stack = ? and stage = ? and fqn = ?",
                  stack,
                  stage,
                  fqn,
                )
                .toArray()[0];
              return row === undefined ? undefined : decodePersistedState(row.value);
            }),
          getReplacedResources: ({ stack, stage }) =>
            attempt("getReplacedResources", () =>
              sql
                .exec<TextRow>(
                  "select value from alchemy_state where stack = ? and stage = ? and fqn <> ?",
                  stack,
                  stage,
                  STACK_OUTPUT_FQN,
                )
                .toArray()
                .map(({ value }) => decodePersistedState(value))
                .filter((state): state is ReplacedResourceState => state.status === "replaced"),
            ),
          set: ({ stack, stage, fqn, value }) =>
            attempt("set", () => {
              write(sql, stack, stage, fqn, value);
              return value;
            }),
          delete: ({ stack, stage, fqn }) =>
            attempt("delete", () => {
              sql.exec(
                "delete from alchemy_state where stack = ? and stage = ? and fqn = ?",
                stack,
                stage,
                fqn,
              );
            }),
          deleteStack: ({ stack, stage }) =>
            attempt("deleteStack", () => {
              if (stage === undefined) {
                sql.exec("delete from alchemy_state where stack = ?", stack);
              } else {
                sql.exec("delete from alchemy_state where stack = ? and stage = ?", stack, stage);
              }
            }),
          list: ({ stack, stage }) =>
            attempt("list", () =>
              sql
                .exec<{ fqn: string }>(
                  "select fqn from alchemy_state where stack = ? and stage = ? and fqn <> ? order by fqn",
                  stack,
                  stage,
                  STACK_OUTPUT_FQN,
                )
                .toArray()
                .map(({ fqn }) => fqn),
            ),
          getOutput: ({ stack, stage }) =>
            attempt("getOutput", () => {
              const row = sql
                .exec<TextRow>(
                  "select value from alchemy_state where stack = ? and stage = ? and fqn = ?",
                  stack,
                  stage,
                  STACK_OUTPUT_FQN,
                )
                .toArray()[0];
              return row === undefined ? undefined : decode(row.value);
            }),
          setOutput: ({ stack, stage, value }) =>
            attempt("setOutput", () => {
              write(sql, stack, stage, STACK_OUTPUT_FQN, value);
              return value;
            }),
        };
        return service;
      }),
    ),
  );
}

function write(sql: SqlStorage, stack: string, stage: string, fqn: string, value: unknown) {
  sql.exec(
    `insert into alchemy_state (stack, stage, fqn, value)
     values (?, ?, ?, ?)
     on conflict (stack, stage, fqn) do update set value = excluded.value`,
    stack,
    stage,
    fqn,
    JSON.stringify(encodeState(value)),
  );
}
