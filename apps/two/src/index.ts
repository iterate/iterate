import { createServer } from "node:http";
import { HttpApiBuilder, HttpMiddleware, HttpServer } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Layer } from "effect";
import { TwoApi } from "./api.ts";
import { AgentsHandlersLive } from "./handlers/agents.ts";
import { SlackHandlersLive } from "./handlers/slack.ts";
import { EventStoreLive } from "./services/event-store.ts";

const SqliteLive = SqliteClient.layer({
  filename: "two.db",
});

const ApiLive = HttpApiBuilder.api(TwoApi).pipe(
  Layer.provide(AgentsHandlersLive),
  Layer.provide(SlackHandlersLive),
);

const ServerLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(ApiLive),
  Layer.provide(EventStoreLive),
  Layer.provide(SqliteLive),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
);

NodeRuntime.runMain(Layer.launch(ServerLive));
