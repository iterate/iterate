import { Hono } from "hono";
import { slackRouter } from "./plugins/slack/router.ts";

const app = new Hono();

// Mount Slack integration
app.route("/api/integrations/slack", slackRouter);

// Return 404 for unhandled routes so daemon can try its own routes
app.all("*", (c) => c.notFound());

export default { fetch: app.fetch };
