import { NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
import { createServerLayers, defaultConfig } from "./server.ts";

const ServerLive = createServerLayers(defaultConfig);

NodeRuntime.runMain(Layer.launch(ServerLive));
