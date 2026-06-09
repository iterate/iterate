// Browser execution mode: a real Chromium tab holds an itx over a Cap'n Web
// WebSocket — the same handle, same scripts, same capability verbs as Node
// and the run harness. The browser is also a PROVIDER: it can register live
// capabilities backed by browser-owned objects (tabs as tool servers).
//
// Auth: browser WebSockets cannot set Authorization headers, so the admin
// cookie is installed through Playwright's context (vitest browser command) —
// same bridge the old capnweb suite used.

import { afterAll, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import type { Itx } from "../handle.ts";
import {
  BROWSER_REPL_EXAMPLES,
  DEFAULT_BROWSER_REPL_CODE,
  evalBrowserReplSessionCode,
} from "../browser-repl.ts";
import { appendAndReadStream, describeProject } from "./itx-scripts.ts";

declare const __ITX_BROWSER_E2E__: {
  adminApiSecret: string;
  baseUrl: string;
};

// Cross-origin WebSockets only carry the admin cookie when it can be
// SameSite=None, which Chromium requires to be Secure — so browser mode needs
// an https target (a deployed preview/prod), never a plain-http local dev URL.
const httpsTarget = __ITX_BROWSER_E2E__.baseUrl.startsWith("https:");

describe.skipIf(!httpsTarget)("itx browser execution mode", () => {
  const createdProjectIds: string[] = [];

  afterAll(async () => {
    using itx = await connectFromBrowser();
    for (const id of createdProjectIds.toReversed()) {
      await itx.projects.remove({ id }).catch(() => {});
    }
  });

  it("runs the default browser REPL snippet against a live itx", async () => {
    using itx = await connectFromBrowser();
    await expect(
      evalBrowserReplSessionCode({
        code: DEFAULT_BROWSER_REPL_CODE,
        env: {},
        itx,
        scope: {},
      }),
    ).resolves.toMatchObject({
      projects: expect.any(Array),
      total: expect.any(Number),
    });
  }, 45_000);

  it("runs the shared itx scripts through browser Cap'n Web stubs", async () => {
    using itx = await connectFromBrowser();
    const project = (await itx.projects.create({
      slug: `itx-browser-${uniqueSuffix()}`.slice(0, 40),
    })) as { id: string; slug: string };
    createdProjectIds.push(project.id);

    await expect(
      describeProject({ itx: itx as never, vars: { projectId: project.id } }),
    ).resolves.toMatchObject({ context: project.id, projectId: project.id });

    const marker = `browser-${uniqueSuffix()}`;
    const streamed = await appendAndReadStream({
      itx: itx as never,
      vars: {
        eventType: "events.iterate.test/itx/browser",
        marker,
        projectId: project.id,
        streamPath: "/itx-e2e/browser",
      },
    });
    expect(streamed.readBackMarkers).toContain(marker);
  }, 45_000);

  it("provides a live browser-owned capability and calls it via the fallthrough", async () => {
    using itx = await connectFromBrowser();
    const project = (await itx.projects.create({
      slug: `itx-browser-cap-${uniqueSuffix()}`.slice(0, 40),
    })) as { id: string };
    createdProjectIds.push(project.id);

    const example = BROWSER_REPL_EXAMPLES.find(
      (candidate) => candidate.id === "provide-live-capability",
    );
    if (!example) throw new Error("Missing provide-live-capability browser REPL example.");

    const alertMessages: string[] = [];
    const originalAlert = globalThis.alert;
    globalThis.alert = (message?: unknown) => {
      alertMessages.push(String(message));
    };
    try {
      await expect(
        evalBrowserReplSessionCode({
          code: example.code,
          env: {},
          itx,
          scope: { projectId: project.id, RpcTarget },
        }),
      ).resolves.toBe("alerted");
    } finally {
      globalThis.alert = originalAlert;
    }
    expect(alertMessages).toEqual(["The answer is 42"]);
  }, 45_000);

  it("provides a browser path-call cap with an SDK-shaped surface", async () => {
    using itx = await connectFromBrowser();
    const project = (await itx.projects.create({
      slug: `itx-browser-sdk-${uniqueSuffix()}`.slice(0, 40),
    })) as { id: string };
    createdProjectIds.push(project.id);

    class BrowserSdk extends RpcTarget {
      async call({ path, args }: { path: string[]; args: unknown[] }) {
        return { args, method: path.join("."), provider: "browser-tab" };
      }
    }

    using projectItx = await itx.projects.get(project.id);
    await projectItx.caps.provide({
      invoke: "path-call",
      name: "browserSlack",
      target: new BrowserSdk() as never,
    });

    const result = (await (
      projectItx as never as Record<string, any>
    ).browserSlack.chat.postMessage({
      channel: "C_BROWSER",
      text: "hello from a browser tab",
    })) as { method: string; provider: string };
    expect(result).toMatchObject({ method: "chat.postMessage", provider: "browser-tab" });
  }, 45_000);
});

// ---- connection -------------------------------------------------------------

async function connectFromBrowser(context?: string): Promise<RpcStub<Itx>> {
  await installAdminCookie();
  const wsUrl = new URL(
    context ? `/api/itx/${encodeURIComponent(context)}` : "/api/itx",
    baseUrl(),
  );
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<Itx>(new WebSocket(wsUrl));
}

async function installAdminCookie() {
  // Vitest's browser page runs on Vitest's own origin; Chromium's local HTTP
  // cookie rules can suppress a cross-origin Set-Cookie, so install the
  // cookie through Playwright's context instead of POSTing /admin-cookie.
  const result = await (
    commands as unknown as {
      setItxAdminCookie(input: { secret: string; url: string }): Promise<{
        cookies?: Array<{ name: string }>;
      }>;
    }
  ).setItxAdminCookie({
    secret: __ITX_BROWSER_E2E__.adminApiSecret,
    url: new URL("/api/itx", baseUrl()).toString(),
  });
  if (!result.cookies?.some((cookie) => cookie.name === "iterate-admin-auth")) {
    throw new Error("iterate-admin-auth cookie was not installed.");
  }
}

function baseUrl() {
  if (!__ITX_BROWSER_E2E__.baseUrl) throw new Error("APP_CONFIG_BASE_URL is required.");
  return __ITX_BROWSER_E2E__.baseUrl;
}

function uniqueSuffix() {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}
