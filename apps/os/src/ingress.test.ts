import { expect, test } from "vitest";
import { decideIngressRoute, type IngressResolvers } from "./ingress.ts";

const PREVIEW_CONFIG = {
  baseUrl: "https://os.iterate-preview-2.com",
  projectHostnameBases: ["iterate-preview-2.app"],
};

const DEV_CONFIG = {
  baseUrl: "http://localhost:56455",
  projectHostnameBases: ["localhost"],
};

test.for([
  {
    name: "keeps the OS host on the app lane",
    config: PREVIEW_CONFIG,
    resolvers: resolversThatShouldNotBeUsed(),
    url: "https://os.iterate-preview-2.com/projects/demo",
    expected: { lane: "os", hostKind: "dashboard" },
  },
  {
    name: "keeps the event docs host on the app lane",
    config: PREVIEW_CONFIG,
    resolvers: resolversThatShouldNotBeUsed(),
    url: "https://events.iterate-preview-2.com/stream/created",
    expected: { lane: "os", hostKind: "eventDocs" },
  },
  {
    name: "does not let the api lane steal the event docs host",
    config: PREVIEW_CONFIG,
    resolvers: resolversThatShouldNotBeUsed(),
    url: "https://events.iterate-preview-2.com/api",
    expected: { lane: "os", hostKind: "eventDocs" },
  },
  {
    name: "does not let deeper api paths steal the event docs host",
    config: PREVIEW_CONFIG,
    resolvers: resolversThatShouldNotBeUsed(),
    url: "https://events.iterate-preview-2.com/api/operator-sessions",
    expected: { lane: "os", hostKind: "eventDocs" },
  },
  {
    name: "does not let the project path lane steal the event docs host",
    config: PREVIEW_CONFIG,
    resolvers: resolversThatShouldNotBeUsed(),
    url: "https://events.iterate-preview-2.com/prj_123/increment",
    expected: { lane: "os", hostKind: "eventDocs" },
  },
  {
    name: "honors x-forwarded-host when classifying event docs hosts",
    config: PREVIEW_CONFIG,
    headers: { "x-forwarded-host": "events.iterate-preview-2.com" },
    resolvers: resolversThatShouldNotBeUsed(),
    url: "https://os.iterate-preview-2.com/stream/created",
    expected: { lane: "os", hostKind: "eventDocs" },
  },
  {
    name: "treats the bare localhost project-host base as an OS app-host alias",
    config: DEV_CONFIG,
    resolvers: resolversThatShouldNotBeUsed(),
    url: "http://localhost:56455/api/health",
    expected: { lane: "os" },
  },
  {
    name: "sends /api on the OS host to the api lane",
    config: DEV_CONFIG,
    resolvers: resolversThatShouldNotBeUsed(),
    url: "http://localhost:56455/api",
    expected: { lane: "api" },
  },
  {
    name: "sends deeper itx paths on the OS host to the api lane",
    config: DEV_CONFIG,
    resolvers: resolversThatShouldNotBeUsed(),
    url: "http://localhost:56455/api/operator-sessions/redeem",
    expected: { lane: "api" },
  },
  // The webhook door lives in the api pipeline (worker.ts), NOT the app
  // router: a webhook path that stays on the "os" lane 404s in the SSR app —
  // which is exactly how prd GitHub webhooks were silently dead until
  // 2026-07-08 (the paths below were missing from the lane predicate).
  {
    name: "sends the slack webhook to the api lane",
    config: DEV_CONFIG,
    method: "POST",
    resolvers: resolversThatShouldNotBeUsed(),
    url: "http://localhost:56455/api/integrations/slack/webhook",
    expected: { lane: "api" },
  },
  {
    name: "sends the slack interactivity webhook to the api lane",
    config: DEV_CONFIG,
    method: "POST",
    resolvers: resolversThatShouldNotBeUsed(),
    url: "http://localhost:56455/api/integrations/slack/interactivity-webhook",
    expected: { lane: "api" },
  },
  {
    name: "sends the github webhook to the api lane",
    config: DEV_CONFIG,
    method: "POST",
    resolvers: resolversThatShouldNotBeUsed(),
    url: "http://localhost:56455/api/integrations/github/webhook",
    expected: { lane: "api" },
  },
  {
    // Telegram's webhook path carries the bot id as a segment, so the lane
    // predicate matches it by prefix (this exact path 404'd on preview-2
    // until 2026-07-08 — same missing-lane failure mode as GitHub's).
    name: "sends the per-bot telegram webhook to the api lane",
    config: DEV_CONFIG,
    method: "POST",
    resolvers: resolversThatShouldNotBeUsed(),
    url: "http://localhost:56455/api/integrations/telegram/webhook/7000001",
    expected: { lane: "api" },
  },
  {
    name: "keeps the slack callback on the os lane",
    config: DEV_CONFIG,
    method: "POST",
    resolvers: resolversThatShouldNotBeUsed(),
    url: "http://localhost:56455/api/integrations/slack/callback",
    expected: { lane: "os" },
  },
  {
    name: "keeps the telegram callback on the os lane",
    config: DEV_CONFIG,
    method: "POST",
    resolvers: resolversThatShouldNotBeUsed(),
    url: "http://localhost:56455/api/integrations/telegram/callback",
    expected: { lane: "os" },
  },
  {
    // No bot id segment → not the webhook shape; the app router owns it. The
    // telegram webhook prefix must not overreach.
    name: "keeps the bot-less telegram webhook path on the os lane",
    config: DEV_CONFIG,
    method: "POST",
    resolvers: resolversThatShouldNotBeUsed(),
    url: "http://localhost:56455/api/integrations/telegram/webhook",
    expected: { lane: "os" },
  },
  {
    name: "rewrites the /prj_<id> path lane to the project sub-path",
    config: DEV_CONFIG,
    method: "POST",
    resolvers: resolversThatShouldNotBeUsed(),
    url: "http://localhost:56455/prj_123/increment",
    expected: { lane: "project", resolved: { projectId: "prj_123", appSlug: null } },
    expectedFetchUrl: "http://localhost:56455/increment",
    // The stripped prefix rides along so workers can render browser-usable URLs.
    expectedFetchHeaders: { "x-itx-project-id": "prj_123", "x-iterate-url-prefix": "/prj_123" },
  },
  {
    name: "host lanes carry no url prefix (and spoofed ones are stripped)",
    config: DEV_CONFIG,
    headers: { "x-iterate-url-prefix": "/prj_spoof" },
    resolvers: slugResolvers({ demo: "prj_1" }),
    url: "http://demo.localhost:56455/",
    expected: { lane: "project" },
    expectedFetchHeaders: { "x-iterate-url-prefix": null },
  },
  {
    name: "keeps localhost subdomains on the project lane without rewriting the URL",
    config: DEV_CONFIG,
    resolvers: slugResolvers({ demo: "prj_1" }),
    url: "http://demo.localhost:56455/some/path?q=1",
    expected: { lane: "project", resolved: { projectId: "prj_1", appSlug: null } },
    expectedFetchUrl: "http://demo.localhost:56455/some/path?q=1",
  },
  {
    name: "passes prj_ ids in hostnames straight through",
    config: PREVIEW_CONFIG,
    resolvers: slugResolvers({}),
    url: "https://prj_123.iterate-preview-2.app/",
    expected: { lane: "project", resolved: { projectId: "prj_123", appSlug: null } },
  },
  {
    name: "selects an app from <app>--<slug> hosts as the trusted x-iterate-app header",
    config: PREVIEW_CONFIG,
    headers: { "x-iterate-app": "spoofed" },
    resolvers: slugResolvers({ demo: "prj_1" }),
    url: "https://hello--demo.iterate-preview-2.app/",
    expected: { lane: "project", resolved: { projectId: "prj_1", appSlug: "hello" } },
    expectedFetchHeaders: { "x-iterate-app": "hello", "x-iterate-host-kind": "platform" },
  },
  {
    name: "selects an app from dotted <app>.<slug> hosts",
    config: PREVIEW_CONFIG,
    resolvers: slugResolvers({ demo: "prj_1" }),
    url: "https://counter.demo.iterate-preview-2.app/",
    expected: { lane: "project", resolved: { projectId: "prj_1", appSlug: "counter" } },
  },
  {
    // A project legitimately named "hello--demo" wins over app "hello" in
    // project "demo" — the bare label is the first candidate.
    name: "prefers a whole-label slug over an app split when both resolve",
    config: PREVIEW_CONFIG,
    resolvers: slugResolvers({ "hello--demo": "prj_whole", demo: "prj_1" }),
    url: "https://hello--demo.iterate-preview-2.app/",
    expected: { lane: "project", resolved: { projectId: "prj_whole", appSlug: null } },
  },
  {
    name: "deletes a spoofed x-iterate-app when the host selects no app",
    config: PREVIEW_CONFIG,
    headers: { "x-iterate-app": "spoofed" },
    resolvers: slugResolvers({ demo: "prj_1" }),
    url: "https://demo.iterate-preview-2.app/",
    expected: { lane: "project" },
    expectedFetchHeaders: { "x-iterate-app": null },
  },
  {
    name: "resolves registered custom hostnames exactly",
    config: PREVIEW_CONFIG,
    resolvers: customHostnameResolvers(),
    url: "https://bla.com/",
    expected: { lane: "project", resolved: { projectId: "prj_custom", appSlug: null } },
    expectedFetchHeaders: { "x-iterate-host-kind": "custom" },
  },
  {
    name: "custom-hostname <app>. subdomains select an app",
    config: PREVIEW_CONFIG,
    resolvers: customHostnameResolvers(),
    url: "https://someapp.bla.com/",
    expected: { lane: "project", resolved: { projectId: "prj_custom", appSlug: "someapp" } },
  },
  {
    name: "404s non-OS hosts that resolve to nothing",
    config: PREVIEW_CONFIG,
    resolvers: slugResolvers({}),
    url: "https://nope.iterate-preview-2.app/",
    expected: { lane: "notFound" },
  },
  {
    name: "honors x-forwarded-host for host classification",
    config: DEV_CONFIG,
    headers: { "x-forwarded-host": "demo.localhost:56455" },
    resolvers: slugResolvers({ demo: "prj_1" }),
    url: "http://localhost:56455/",
    expected: { lane: "project", resolved: { projectId: "prj_1" } },
  },
  {
    name: "ignores the deleted ingress-hostname handoff header",
    config: DEV_CONFIG,
    headers: { "x-iterate-ingress-hostname": "demo.localhost:56455" },
    resolvers: resolversThatShouldNotBeUsed(),
    url: "http://localhost:56455/projects/demo",
    expected: { lane: "os" },
  },
])(
  "$name",
  async ({
    config,
    expected,
    expectedFetchHeaders,
    expectedFetchUrl,
    headers,
    method,
    resolvers,
    url,
  }) => {
    const route = await decideIngressRoute({
      config,
      // The row-union's phantom `key?: undefined` members (absent at runtime)
      // are not assignable to HeadersInit, hence the double cast.
      ...(headers === undefined ? {} : { headers: headers as unknown as Record<string, string> }),
      method: method ?? "GET",
      resolvers,
      url,
    });

    expect(route).toMatchObject(expected);
    if (expectedFetchUrl !== undefined) {
      expect((route as { fetch: { url: string } }).fetch.url).toBe(expectedFetchUrl);
    }
    for (const [header, value] of Object.entries(expectedFetchHeaders ?? {})) {
      expect((route as { fetch: { headers: Headers } }).fetch.headers.get(header)).toBe(value);
    }
  },
);

function resolversThatShouldNotBeUsed(): IngressResolvers {
  return {
    projectIdBySlug() {
      throw new Error("OS app-host lanes should not resolve project slugs.");
    },
    projectByHostname() {
      throw new Error("OS app-host lanes should not resolve custom hostnames.");
    },
  };
}

function slugResolvers(bySlug: Record<string, string>): IngressResolvers {
  return {
    projectIdBySlug: (identifier) =>
      Promise.resolve(identifier.startsWith("prj_") ? identifier : (bySlug[identifier] ?? null)),
    projectByHostname: () => Promise.resolve(null),
  };
}

function customHostnameResolvers(): IngressResolvers {
  return {
    projectIdBySlug: () => Promise.resolve(null),
    projectByHostname: (host) =>
      Promise.resolve(
        host === "bla.com"
          ? { projectId: "prj_custom", appSlug: null }
          : host === "someapp.bla.com"
            ? { projectId: "prj_custom", appSlug: "someapp" }
            : null,
      ),
  };
}
