import { createServer } from "node:http";
import * as path from "node:path";
import { HttpApiBuilder, HttpMiddleware, HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Exit, Layer, Scope } from "effect";
import { TwoApi } from "./api.ts";
import { AgentsHandlersLive } from "./handlers/agents.ts";
import { InternalHandlersLive } from "./handlers/internal.ts";
import { SlackHandlersLive } from "./handlers/slack.ts";
import { makeOpenCodeService } from "./opencode/service.ts";
import { SessionManagerLive } from "./opencode/session-manager.ts";
import { EventStoreLive } from "./services/event-store.ts";
import { SubscriptionManager, SubscriptionManagerLive } from "./services/subscription-manager.ts";

export interface ServerConfig {
  httpPort: number;
  openCodePort: number;
  dbFilename: string;
  workspacesDir: string;
}

export interface RunningServer {
  baseUrl: string;
  shutdown: () => Promise<void>;
}

export const defaultConfig: ServerConfig = {
  httpPort: 3000,
  openCodePort: 14096,
  dbFilename: "two.db",
  workspacesDir: process.cwd(),
};

export function createServerLayers(config: ServerConfig) {
  const SqliteLive = SqliteClient.layer({
    filename: config.dbFilename,
  });

  const OpenCodeServiceLive = makeOpenCodeService({
    baseWorkingDirectory: config.workspacesDir,
    port: config.openCodePort,
    hostname: "127.0.0.1",
  });

  const ApiLive = HttpApiBuilder.api(TwoApi).pipe(
    Layer.provide(AgentsHandlersLive),
    Layer.provide(SlackHandlersLive),
    Layer.provide(InternalHandlersLive),
  );

  const StartSubscriptionsLive = Layer.scopedDiscard(
    Effect.gen(function* () {
      const subscriptionManager = yield* SubscriptionManager;
      yield* subscriptionManager.start();
    }),
  );

  const ServerLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
    Layer.provide(ApiLive),
    Layer.provide(StartSubscriptionsLive),
    Layer.provide(SubscriptionManagerLive),
    Layer.provide(OpenCodeServiceLive),
    Layer.provide(SessionManagerLive),
    Layer.provide(EventStoreLive),
    Layer.provide(SqliteLive),
    HttpServer.withLogAddress,
    Layer.provide(NodeHttpServer.layer(createServer, { port: config.httpPort })),
  );

  return ServerLive;
}

export async function startServer(config: Partial<ServerConfig> = {}): Promise<RunningServer> {
  const fullConfig = { ...defaultConfig, ...config };
  const ServerLive = createServerLayers(fullConfig);

  const scope = Effect.runSync(Scope.make());

  const runtime = await Effect.runPromise(Layer.toRuntime(ServerLive).pipe(Scope.extend(scope)));

  const baseUrl = `http://localhost:${fullConfig.httpPort}`;

  const waitForReady = async (maxAttempts = 50, delayMs = 100) => {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`${baseUrl}/internal/agents`);
        if (response.ok) {
          return;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Server failed to start on ${baseUrl}`);
  };

  await waitForReady();

  return {
    baseUrl,
    shutdown: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    },
  };
}
