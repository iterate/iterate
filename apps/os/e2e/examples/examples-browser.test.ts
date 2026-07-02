// Browser execution mode: a real Chromium tab holds an itx handle over a
// Cap'n Web WebSocket (/api/itx) — the same stubs, same catalogue
// examples, same capability verbs as Node and the worker runtimes. Examples
// run through the REAL REPL evaluation pipeline (compile + import rewriting +
// scope), so what the Examples panel shows is exactly what this suite proves.
// The browser is also a PROVIDER: it can mount live capabilities backed by
// browser-owned objects (tabs as tool servers).
//
// Auth: browser WebSockets cannot set Authorization headers, so the admin
// cookie is installed through Playwright's context (vitest browser command);
// the itx from-server-cookie lane accepts the `iterate-admin-auth`
// cookie riding the handshake.

import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { Itx, Session, UnauthenticatedItx } from "../../src/types.ts";
import {
  createBrowserReplScope,
  DEFAULT_BROWSER_REPL_CODE,
  evalBrowserReplSessionCode,
} from "../../src/itx/browser-repl.ts";
import { ITX_EXAMPLES } from "../../src/itx/examples.ts";
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
  (example) =>
    example.context === "project" &&
    example.runtimes.includes("browser") &&
    EXAMPLE_CASES[example.id] !== undefined,
);

describe.skipIf(!httpsTarget)("itx browser execution mode", () => {
  it("runs the default browser REPL snippet against a live session", async () => {
    using session = await connectFromBrowser();
    const result = await evalBrowserReplSessionCode({
      code: DEFAULT_BROWSER_REPL_CODE,
      itx: session,
      scope: createBrowserReplScope(),
    });
    expect(Array.isArray(result)).toBe(true);
  }, 45_000);

  // The catalogue, through the real REPL pipeline, against a project-scoped
  // session — the browser leg of the cross-runtime matrix. One shared project
  // (created lazily by the first example) mirrors the node-side matrix.
  let sharedProjectId: Promise<string> | null = null;
  function ensureBrowserMatrixProject(): Promise<string> {
    sharedProjectId ??= (async () => {
      using session = await connectFromBrowser();
      using project = session.projects.create({
        slug: `itx-browser-${uniqueSuffix()}`.slice(0, 40),
      });
      return (await project.describe()).projectId;
    })();
    return sharedProjectId;
  }

  for (const example of BROWSER_EXAMPLES) {
    const exampleCase = EXAMPLE_CASES[example.id]!;
    it(`runs catalogue example "${example.id}" in the REPL pipeline`, async () => {
      const projectId = await ensureBrowserMatrixProject();
      using session = await connectFromBrowser();
      using project = session.projects.get(projectId);

      const ctx = { marker: `browser-${uniqueSuffix()}`, projectId };
      const vars = exampleCase.vars?.(ctx) ?? {};
      const result = await evalBrowserReplSessionCode({
        code: example.code,
        itx: project,
        scope: createBrowserReplScope({ projectId, vars }),
      });
      exampleCase.assert(result, ctx, expect);
    }, 120_000);
  }

  // The browser-as-provider story (a tab mounting live, browser-owned
  // objects) is covered by the matrix run of "provide-live-capability": its
  // closures live in this tab, so the asserted values can only have been
  // computed by calls travelling back over the open session.

  it("provides a browser live capability with a flattened SDK-shaped surface", async () => {
    const projectId = await ensureBrowserMatrixProject();
    using session = await connectFromBrowser();
    using project = session.projects.get(projectId);

    using provision = await project.provideCapability({
      capability: {
        invokeCapability({ args, path }: { args: unknown[]; path: string[] }) {
          return { args, method: path.join("."), provider: "browser-tab" };
        },
      },
      flattenNestedPaths: true,
      path: ["browserSlack"],
      type: "live",
    });

    const result = (await (project as never as Record<string, any>).browserSlack.chat.postMessage({
      channel: "C_BROWSER",
      text: "hello from a browser tab",
    })) as { method: string; provider: string };
    expect(result).toMatchObject({ method: "chat.postMessage", provider: "browser-tab" });
    await provision.revoke();
  }, 45_000);
});

// ---- connection -------------------------------------------------------------

/**
 * An admin Session for this tab. Cookie-authenticated: the admin cookie rides
 * the WebSocket handshake and `authenticate({ type: "from-server-cookie" })`
 * exchanges it for the session catalog, pipelined on the same socket.
 */
async function connectFromBrowser(): Promise<RpcStub<Session & Itx>> {
  await installAdminCookie();
  // The itx capnweb surface is served at /api/itx (mirrors ~/itx/itx-react.tsx).
  const wsUrl = new URL("/api/itx", baseUrl());
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const unauthenticated = newWebSocketRpcSession<UnauthenticatedItx>(new WebSocket(wsUrl));
  return unauthenticated.authenticate({ type: "from-server-cookie" }) as unknown as RpcStub<
    Session & Itx
  >;
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
