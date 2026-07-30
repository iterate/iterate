import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import * as Apply from "alchemy/Apply";
import { Cli, type CLIService } from "alchemy/Cli/Cli";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import * as Stack from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import type * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { CompiledEnvironment } from "../environments.ts";
import { AlchemyResources, type ResourceProgress } from "../state.ts";
import { makeEnvironmentResources } from "./environment-resources.ts";
import { makeSqliteAlchemyState } from "./sqlite-state.ts";

const STACK_NAME = "IterateDataResources";

function makeProviders(input: { accountId: string; apiToken: string }) {
  const providerServices = Layer.mergeAll(
    Cloudflare.D1.DatabaseProvider(),
    Cloudflare.KV.NamespaceProvider(),
    Cloudflare.R2.BucketProvider(),
  );
  const cloudflareApi = Layer.mergeAll(
    Credentials.fromApiToken({ apiToken: input.apiToken }),
    FetchHttpClient.layer,
    Layer.succeed(
      Cloudflare.CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken",
        apiToken: Redacted.make(input.apiToken),
        accountId: input.accountId,
        source: { type: "env" },
      } satisfies Effect.Success<(typeof Cloudflare.CloudflareEnvironment)["Service"]>),
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
  environment: CompiledEnvironment;
  providers: ReturnType<typeof makeProviders>;
  state: ReturnType<typeof makeSqliteAlchemyState>;
}): Effect.Effect<Stack.CompiledStack<AlchemyResources>, Config.ConfigError, Stage> {
  // Stack.make currently advertises every possible StackServices dependency,
  // even when the supplied graph and layers require none of them. Alchemy's
  // own low-level tests use the same boundary while that upstream typing is
  // being corrected:
  // https://github.com/alchemy-run/alchemy/blob/cd6671e297375282104ba81ec6dcb6347ab7a0fd/packages/alchemy/test/action.test.ts#L54-L68
  // @ts-expect-error upstream Stack.make requirement inference is intentionally broad
  return makeEnvironmentResources(input.environment).pipe(
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
  environment: CompiledEnvironment;
  operation: "deploy" | "destroy";
  storage: DurableObjectStorage;
  onProgress: (progress: ResourceProgress) => void;
}): Promise<AlchemyResources | undefined> {
  const state = makeSqliteAlchemyState(input.storage);
  const providers = makeProviders(input);
  const program = compileEnvironmentStack({
    environment: input.environment,
    providers,
    state,
  }).pipe(
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
    Effect.provide(Layer.succeed(Stage, input.environment.stage)),
    Effect.provide(makeCli(input.onProgress)),
  );

  const output = await Effect.runPromise(Effect.scoped(program));
  return output === undefined ? undefined : AlchemyResources.parse(output);
}
