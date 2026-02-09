import { createRequestHandler } from "react-router";
import { proxy } from "hono/proxy";
import { Hono } from "hono";
import { wellKnownSkillsRegistry } from "./generated/skills-registry.ts";

const requestHandler = createRequestHandler(
  //@ts-expect-error - this is a virtual module
  () => import("virtual:react-router/server-build"),
);

const app = new Hono();
const WELL_KNOWN_SKILLS_PREFIX = "/.well-known/skills";

function contentTypeFor(pathname: string): string {
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  if (pathname.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (pathname.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "text/plain; charset=utf-8";
}

app.get("*", async (c, next) => {
  if (c.req.header("Host") === "iterate.com") {
    return c.redirect("https://www.iterate.com", 301);
  }
  return next();
});

app.get(WELL_KNOWN_SKILLS_PREFIX, (c) => {
  return c.redirect(`${WELL_KNOWN_SKILLS_PREFIX}/index.json`, 302);
});

app.get(`${WELL_KNOWN_SKILLS_PREFIX}/`, (c) => {
  return c.redirect(`${WELL_KNOWN_SKILLS_PREFIX}/index.json`, 302);
});

app.get(`${WELL_KNOWN_SKILLS_PREFIX}/index.json`, (c) => {
  return c.json({ skills: wellKnownSkillsRegistry.skills });
});

app.get(`${WELL_KNOWN_SKILLS_PREFIX}/*`, (c) => {
  const rawPath = c.req.path.slice(`${WELL_KNOWN_SKILLS_PREFIX}/`.length);
  const filePath = decodeURIComponent(rawPath);
  const content = wellKnownSkillsRegistry.fileContents[filePath];

  if (!content) {
    return c.notFound();
  }

  return new Response(content, {
    headers: {
      "content-type": contentTypeFor(filePath),
      "cache-control": "public, max-age=300",
    },
  });
});

// PostHog proxy routes (order matters - most specific first)
const POSTHOG_PROXY_PREFIX = "/api/integrations/posthog/proxy";

app.all(`${POSTHOG_PROXY_PREFIX}/decide`, async (c) => {
  const url = new URL(c.req.url);
  const targetUrl = `https://eu.i.posthog.com/decide${url.search}`;
  return proxy(targetUrl, { ...c.req });
});

app.all(`${POSTHOG_PROXY_PREFIX}/static/*`, async (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(`${POSTHOG_PROXY_PREFIX}/static`, "");
  const targetUrl = `https://eu-assets.i.posthog.com/static${path}${url.search}`;
  return proxy(targetUrl, { ...c.req });
});

app.all(`${POSTHOG_PROXY_PREFIX}/*`, async (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(POSTHOG_PROXY_PREFIX, "");
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
