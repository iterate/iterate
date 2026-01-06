import { createServer } from "node:http";
import * as path from "node:path";
import { HttpApiBuilder, HttpMiddleware, HttpServer } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer } from "effect";
import { TwoApi } from "./api.ts";
import { AgentsHandlersLive } from "./handlers/agents.ts";
import { InternalHandlersLive } from "./handlers/internal.ts";
import { SlackHandlersLive } from "./handlers/slack.ts";
import { makeOpenCodeService } from "./opencode/service.ts";
import { SessionManagerLive } from "./opencode/session-manager.ts";
import { EventStoreLive } from "./services/event-store.ts";
import { SubscriptionManager, SubscriptionManagerLive } from "./services/subscription-manager.ts";

const SqliteLive = SqliteClient.layer({
  filename: "two.db",
});

const OpenCodeServiceLive = makeOpenCodeService({
  baseWorkingDirectory: path.resolve(process.cwd(), "workspaces"),
  port: 14096,
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
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
);

NodeRuntime.runMain(Layer.launch(ServerLive));
