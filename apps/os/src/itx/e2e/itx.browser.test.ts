// Browser execution mode: a real Chromium tab holds an itx over a Cap'n Web
// WebSocket — the same handle, same catalogue examples, same capability verbs
// as Node, the CLI, and the worker runtimes. Examples run through the REAL
// REPL evaluation pipeline (compile + import rewriting + scope), so what the
// Examples panel shows is exactly what this suite proves. The browser is also
// a PROVIDER: it can register live capabilities backed by browser-owned
// objects (tabs as tool servers).
//
// Auth: browser WebSockets cannot set Authorization headers, so the admin
// cookie is installed through Playwright's context (vitest browser command) —
// same bridge the old capnweb suite used.

import { afterAll, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import type { ItxHandle } from "../handle.ts";
import {
  createBrowserReplScope,
  DEFAULT_BROWSER_REPL_CODE,
  evalBrowserReplSessionCode,
} from "../browser-repl.ts";
import { ITX_EXAMPLES } from "../examples.ts";
import { EXAMPLE_CASES } from "./example-cases.ts";

declare const __ITX_BROWSER_E2E__: {
  adminApiSecret: string;
  baseUrl: string;
};

// Cross-origin WebSockets only carry the admin cookie when it can be
// SameSite=None, which Chromium requires to be Secure — so browser mode needs
// an https target (a deployed preview/prod), never a plain-http local dev URL.
const httpsTarget = __ITX_BROWSER_E2E__.baseUrl.startsWith("https:");

const BROWSER_EXAMPLES = ITX_EXAMPLES.filter(
  (example) => example.runtimes.includes("browser") && EXAMPLE_CASES[example.id] !== undefined,
);

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
        scope: createBrowserReplScope(),
      }),
    ).resolves.toMatchObject({
      projects: expect.any(Array),
      total: expect.any(Number),
    });
  }, 45_000);

  // The catalogue, through the real REPL pipeline, against a project-scoped
  // session — the browser leg of the cross-runtime matrix. One shared project
  // (created lazily by the first example) mirrors the node-side matrix.
  let sharedProjectId: Promise<string> | null = null;
  function ensureBrowserMatrixProject(): Promise<string> {
    sharedProjectId ??= (async () => {
      using itx = await connectFromBrowser();
      const project = (await itx.projects.create({
        slug: `itx-browser-${uniqueSuffix()}`.slice(0, 40),
      })) as { id: string };
      createdProjectIds.push(project.id);
      return project.id;
    })();
    return sharedProjectId;
  }

  for (const example of BROWSER_EXAMPLES) {
    const exampleCase = EXAMPLE_CASES[example.id]!;
    it(`runs catalogue example "${example.id}" in the REPL pipeline`, async () => {
      const projectId = await ensureBrowserMatrixProject();
      using itx = await connectFromBrowser(projectId);

      const ctx = { marker: `browser-${uniqueSuffix()}`, projectId };
      const vars = exampleCase.vars?.(ctx) ?? {};
      const result = await evalBrowserReplSessionCode({
        code: example.code,
        env: {},
        itx,
        scope: createBrowserReplScope({ projectId, vars }),
      });
      exampleCase.assert(result, ctx);
    }, 120_000);
  }

  it("provides a live browser-owned capability and calls it via the fallthrough (alert example)", async () => {
    const projectId = await ensureBrowserMatrixProject();
    using itx = await connectFromBrowser(projectId);

    const example = ITX_EXAMPLES.find((candidate) => candidate.id === "provide-live-capability");
    if (!example) throw new Error("Missing provide-live-capability example.");

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
          scope: createBrowserReplScope({ projectId }),
        }),
      ).resolves.toBe("alerted");
    } finally {
      globalThis.alert = originalAlert;
    }
    expect(alertMessages).toEqual(["The answer is 42"]);
  }, 45_000);

  it("provides a browser path-call cap with an SDK-shaped surface", async () => {
    const projectId = await ensureBrowserMatrixProject();
    using projectItx = await connectFromBrowser(projectId);

    class BrowserSdk extends RpcTarget {
      async call({ path, args }: { path: string[]; args: unknown[] }) {
        return { args, method: path.join("."), provider: "browser-tab" };
      }
    }

    await projectItx.provideCapability({
      name: "browserSlack",
      provider: new BrowserSdk() as never,
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

async function connectFromBrowser(context?: string): Promise<RpcStub<ItxHandle>> {
  await installAdminCookie();
  const wsUrl = new URL(
    context ? `/api/itx/${encodeURIComponent(context)}` : "/api/itx",
    baseUrl(),
  );
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<ItxHandle>(new WebSocket(wsUrl));
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
