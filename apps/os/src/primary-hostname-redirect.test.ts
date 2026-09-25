// primary-hostname-redirect.test.ts — which requests the edge sends to a project's primary hostname:
// `{ request → routing slug kept, or undefined }` rows.
import { expect, test } from "vitest";
import type { IngressRouting } from "iterate/project-ingress";
import { primaryHostnameRedirectOf } from "./primary-hostname-redirect.ts";

const subdomains: IngressRouting = { type: "subdomains", hostname: "iterate.app" };
const PLATFORM = "https://os.iterate.com";
const navigate = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

test.each<{
  why: string;
  url: string;
  method?: string;
  headers: Record<string, string>;
  redirect?: { routingSlug: string | null };
}>([
  {
    why: "a navigation on `<routingSlug>--<project>` keeps its routing slug",
    url: "https://blog--p.iterate.app/a?b=1",
    headers: navigate,
    redirect: { routingSlug: "blog" },
  },
  {
    why: "a navigation on `<routingSlug>.<project>` keeps its routing slug",
    url: "https://blog.p.iterate.app/",
    headers: navigate,
    redirect: { routingSlug: "blog" },
  },
  {
    why: "a navigation on the apex goes to the primary's apex",
    url: "https://p.iterate.app/",
    headers: navigate,
    redirect: { routingSlug: null },
  },
  {
    why: "HEAD is a navigation too",
    url: "https://p.iterate.app/",
    method: "HEAD",
    headers: navigate,
    redirect: { routingSlug: null },
  },
  {
    why: "without Fetch Metadata, a GET that accepts HTML is a page",
    url: "https://p.iterate.app/",
    headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    redirect: { routingSlug: null },
  },
  {
    why: "without Fetch Metadata, a GET that does not ask for HTML is a fetch",
    url: "https://p.iterate.app/",
    headers: { accept: "*/*" },
  },
  {
    why: "a fetch() from a page is not a navigation, whatever it accepts",
    url: "https://p.iterate.app/data",
    headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", accept: "text/html" },
  },
  {
    why: "an iframe's navigation is not top-level",
    url: "https://p.iterate.app/",
    headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" },
  },
  {
    why: "a POST is never redirected",
    url: "https://p.iterate.app/form",
    method: "POST",
    headers: navigate,
  },
  {
    why: "a WebSocket upgrade is never redirected",
    url: "https://p.iterate.app/socket",
    headers: { ...navigate, upgrade: "websocket" },
  },
  {
    why: "the files host is never redirected",
    url: "https://files--p.iterate.app/f/x",
    headers: navigate,
  },
  {
    why: "a request already on a project's own hostname is not on the ingress base",
    url: "https://blog.templestein.com/",
    headers: navigate,
  },
  { why: "the platform origin is not a project host", url: PLATFORM, headers: navigate },
])("$why", ({ url, method = "GET", headers, redirect }) => {
  expect(
    primaryHostnameRedirectOf(new Request(url, { method, headers }), {
      routing: subdomains,
      platformOrigin: PLATFORM,
    }),
  ).toEqual(redirect);
});

test("paths routing is never redirected: it has no custom hostnames", () => {
  const request = new Request(`${PLATFORM}/projects/p/blog/`, { headers: navigate });
  expect(
    primaryHostnameRedirectOf(request, { routing: { type: "paths" }, platformOrigin: PLATFORM }),
  ).toBeUndefined();
});
