import { Retry } from "@distilled.cloud/cloudflare";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as Apply from "alchemy/Apply";
import { Cli, type CLIService } from "alchemy/Cli/Cli";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Duration from "effect/Duration";
import type * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { EnvironmentResources, type ResourceProgress } from "../state.ts";
import { makeEnvironmentResources } from "./environment-resources.ts";
import { makeSqliteAlchemyState } from "./sqlite-state.ts";

const STACK_NAME = "IterateDataResources";

/**
 * Alchemy's normal bounded Cloudflare policy, retained for the long-lived
 * control plane. It retries SDK-classified transient failures plus the three
 * misleading Cloudflare auth responses Alchemy itself classifies as transient.
 */
const cloudflareRetry: Retry.Factory = (lastError) => {
  const defaults = Retry.makeDefault(lastError);
  return {
    while: (error) => defaults.while?.(error) === true || isMisleadinglyTaggedTransient(error),
    schedule: Schedule.max([
      pipe(
        Schedule.exponential(Duration.millis(250), 2),
        Schedule.modifyDelay(
          Effect.fn(function* ({ duration }) {
            const error = yield* Ref.get(lastError);
            if (
              (error as { _tag?: unknown } | null)?._tag === "TooManyRequests" &&
              Duration.toMillis(duration) < 500
            ) {
              return 500;
            }
            return Duration.toMillis(duration);
          }),
        ),
        Retry.capped(Duration.seconds(5)),
        Retry.jittered,
      ),
      Schedule.recurs(8),
    ]),
  };
};

function isMisleadinglyTaggedTransient(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const tag = (error as { _tag?: unknown })._tag;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  if (tag === "Forbidden" && /internal error|unable to authenticate request/i.test(message)) {
    return true;
  }
  return (tag === "Forbidden" || tag === "Unauthorized") && /authentication error/i.test(message);
}

function makeProviders(input: { accountId: string; apiToken: string }) {
  const providerServices = Layer.mergeAll(
    Cloudflare.D1.DatabaseProvider(),
    Cloudflare.KV.NamespaceProvider(),
    Cloudflare.R2.BucketProvider(),
  );
  const cloudflareApi = Layer.mergeAll(
    Credentials.fromApiToken({ apiToken: input.apiToken }),
    FetchHttpClient.layer,
    Layer.succeed(Retry.Retry, cloudflareRetry),
    Layer.succeed(
      Cloudflare.CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken" as const,
        apiToken: Redacted.make(input.apiToken),
        accountId: input.accountId,
        source: { type: "env" as const },
      }),
    ),
  );

  return Layer.effect(
    Cloudflare.Providers,
    Provider.collection([Cloudflare.D1.Database, Cloudflare.KV.Namespace, Cloudflare.R2.Bucket]),
  ).pipe(Layer.provideMerge(providerServices), Layer.provideMerge(cloudflareApi), Layer.orDie);
}

function makeCli(onProgress: (progress: ResourceProgress) => void): Layer.Layer<Cli> {
  const service: CLIService = {
    approvePlan: () => Effect.succeed(true),
    displayPlan: () => Effect.void,
    startApplySession: () =>
      Effect.succeed({
        emit: (event) =>
          Effect.sync(() => {
            if (event.kind === "status-change") {
              onProgress({
                id: event.id,
                type: event.type,
                status: event.status,
                message: event.message,
              });
              return;
            }
            onProgress({
              id: event.id,
              type: "annotation",
              status: "note",
              message: event.message,
            });
          }),
        done: () => Effect.void,
      }),
  };
  return Layer.succeed(Cli, service);
}

function compileEnvironmentStack(input: {
  providers: ReturnType<typeof makeProviders>;
  stage: string;
  state: ReturnType<typeof makeSqliteAlchemyState>;
}): Effect.Effect<Stack.CompiledStack<EnvironmentResources>, Config.ConfigError, Stage> {
  // Stack.make currently advertises every possible StackServices dependency,
  // even when the supplied graph and layers require none of them. Alchemy's
  // own low-level tests use the same boundary while that upstream typing is
  // being corrected. This graph is deliberately limited to D1/KV/R2.
  // @ts-expect-error upstream Stack.make requirement inference is intentionally broad
  return makeEnvironmentResources(input.stage).pipe(
    Stack.make({
      name: STACK_NAME,
      providers: input.providers,
      state: input.state,
    }),
  );
}

export async function runEnvironmentAlchemy(input: {
  accountId: string;
  apiToken: string;
  operation: "deploy" | "destroy";
  sql: SqlStorage;
  stage: string;
  onProgress: (progress: ResourceProgress) => void;
}): Promise<EnvironmentResources | undefined> {
  const state = makeSqliteAlchemyState(input.sql);
  const providers = makeProviders(input);
  const program = compileEnvironmentStack({ providers, stage: input.stage, state }).pipe(
    Effect.flatMap((compiled) => {
      if (input.operation === "destroy") {
        return Plan.destroy(compiled).pipe(
          Effect.flatMap(Apply.apply),
          Effect.provide(compiled.services),
        );
      }
      return Plan.make(compiled).pipe(
        Effect.flatMap(Apply.apply),
        Effect.provide(compiled.services),
      );
    }),
    Effect.provide(Layer.succeed(Stage, input.stage)),
    Effect.provide(makeCli(input.onProgress)),
  );

  const output = await Effect.runPromise(program);
  return output === undefined ? undefined : EnvironmentResources.parse(output);
}
