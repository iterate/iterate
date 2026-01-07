import { Hono } from "hono";
import type { CloudflareEnv } from "../../env.ts";
import type { Variables } from "../worker.ts";
import { slackEdgeApp } from "./slack.ts";

export const edgeApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

edgeApp.route("/slack", slackEdgeApp);
