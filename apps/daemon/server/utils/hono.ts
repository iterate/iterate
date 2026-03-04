import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";

export const baseApp = new Hono();

export const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: baseApp });
