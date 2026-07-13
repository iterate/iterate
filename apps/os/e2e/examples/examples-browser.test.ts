// Browser execution mode: a real Chromium tab holds an itx handle over a
// Cap'n Web WebSocket (/api) — the same stubs, same catalogue
// examples, same capability verbs as Node and the worker runtimes. Examples
// run through the REAL REPL evaluation pipeline (compile + import rewriting +
// scope), so what the Examples panel shows is exactly what this suite proves.
// The browser is also a PROVIDER: it can mount live capabilities backed by
// browser-owned objects (tabs as tool servers).
//
// Auth: the Vitest page is deliberately cross-origin from OS. A Playwright
// command mints a short-lived explicit operator grant server-side, keeping the
// deployment admin secret out of the browser bundle entirely.

import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type {
  Project as ProjectRpcTarget,
  Session,
  UnauthenticatedOs,
} from "../../src/itx-api.generated.ts";
import {
  createBrowserReplScope,
  DEFAULT_BROWSER_REPL_CODE,
  evalBrowserReplSessionCode,
} from "../../src/itx/browser-repl.ts";
import { ITX_EXAMPLES } from "../../src/itx/examples.ts";
import { EXAMPLE_CASES } from "./example-cases.ts";

declare const __ITX_BROWSER_E2E__: {
  baseUrl: string;
};

const hasTarget = __ITX_BROWSER_E2E__.baseUrl !== "";
const targetHostname = hasTarget ? new URL(__ITX_BROWSER_E2E__.baseUrl).hostname : "";
const localTarget =
  ["localhost", "127.0.0.1", "::1"].includes(targetHostname) ||
  targetHostname.endsWith(".localhost");

const BROWSER_EXAMPLES = ITX_EXAMPLES.filter(
  (example) =>
    example.context === "project" &&
    example.runtimes.includes("browser") &&
    EXAMPLE_CASES[example.id] !== undefined,
);

describe.skipIf(!hasTarget)("itx browser execution mode", () => {
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
      return (await project.__describe()).projectId;
    })();
    return sharedProjectId;
  }

  for (const example of BROWSER_EXAMPLES) {
    const exampleCase = EXAMPLE_CASES[example.id]!;
    it.skipIf(localTarget && example.id === "sandbox-exec")(
      `runs catalogue example "${example.id}" in the REPL pipeline`,
      async () => {
        const projectId = await ensureBrowserMatrixProject();
        using session = await connectFromBrowser();
        using project = session.projects.get(projectId);

        const ctx = { attemptSalt: uniqueSuffix(), marker: `browser-${uniqueSuffix()}`, projectId };
        const vars = exampleCase.vars?.(ctx) ?? {};
        const result = await evalBrowserReplSessionCode({
          code: example.code,
          itx: project,
          scope: createBrowserReplScope({ projectId, vars }),
        });
        exampleCase.assert(result, ctx, expect);
      },
      120_000,
    );
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
 * A platform-authorized Session for this tab. The short-lived operator grant
 * is explicit RPC data, so no cross-origin ambient browser credential is
 * involved.
 */
async function connectFromBrowser(): Promise<RpcStub<Session & ProjectRpcTarget>> {
  const token = await operatorSessionToken();
  // The itx capnweb surface is served at /api (mirrors ~/itx/itx-react.tsx).
  const wsUrl = new URL("/api", baseUrl());
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const unauthenticated = newWebSocketRpcSession<UnauthenticatedOs>(new WebSocket(wsUrl));
  return unauthenticated.authenticate({ type: "operator-session", token }) as unknown as RpcStub<
    Session & ProjectRpcTarget
  >;
}

let operatorTokenPromise: Promise<string> | null = null;
function operatorSessionToken() {
  operatorTokenPromise ??= (
    commands as unknown as {
      mintItxOperatorToken(input: { url: string }): Promise<{ token: string }>;
    }
  )
    .mintItxOperatorToken({ url: baseUrl() })
    .then((result) => result.token);
  return operatorTokenPromise;
}

function baseUrl() {
  if (!__ITX_BROWSER_E2E__.baseUrl) throw new Error("APP_CONFIG_BASE_URL is required.");
  return __ITX_BROWSER_E2E__.baseUrl;
}

function uniqueSuffix() {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}
