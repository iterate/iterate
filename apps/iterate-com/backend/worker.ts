import { createRequestHandler } from "react-router";
import { proxy } from "hono/proxy";
import { Hono } from "hono";

const requestHandler = createRequestHandler(
  //@ts-expect-error - this is a virtual module
  () => import("virtual:react-router/server-build"),
);

const app = new Hono();

app.get("*", async (c, next) => {
  if (c.req.header("Host") === "iterate.com") {
    return c.redirect("https://www.iterate.com", 301);
  }
  return next();
});

// PostHog proxy routes (order matters - most specific first)
app.all("/ingest/decide", async (c) => {
  const url = new URL(c.req.url);
  const targetUrl = `https://eu.i.posthog.com/decide${url.search}`;
  return proxy(targetUrl, { ...c.req });
});

app.all("/ingest/static/*", async (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname.replace("/ingest/static", "");
  const targetUrl = `https://eu-assets.i.posthog.com/static${path}${url.search}`;
  return proxy(targetUrl, { ...c.req });
});

app.all("/ingest/*", async (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname.replace("/ingest", "");
  const targetUrl = `https://eu.i.posthog.com${path}${url.search}`;
  return proxy(targetUrl, { ...c.req });
});

// React Router fallback for 404s
app.notFound((c) => {
  return requestHandler(c.req.raw);
});

// Export the Hono app directly as the default export
// Cloudflare Workers will use the fetch method from the Hono app
export default app;
