// Browser execution mode: a real Chromium tab holds an itx over a Cap'n Web
// WebSocket — the same handle, same catalogue examples (examples.ts), same
// capability verbs as Node, the CLI, and the worker runtimes. This is the
// browser leg of the cross-runtime matrix. Mirrors
// apps/os/src/itx/e2e/itx.browser.test.ts.
//
// Auth: browser WebSockets cannot set an Authorization header, so this
// reference client sends the same demo token as `?token=…` (auth.ts accepts
// it). That means — unlike apps/os, which needs an https target for its
// SameSite=None admin cookie — this suite runs against a plain-http local dev
// worker too. baseUrl + token are injected by vitest.config.ts via `define`
// because the browser cannot read process.env.

import { describe, expect, it } from "vitest";
import { newWebSocketRpcSession } from "capnweb";
import { EXAMPLE_CASES } from "./example-cases.ts";
import { ITX_EXAMPLES } from "./examples.ts";

declare const __ITX_BROWSER_E2E__: { baseUrl: string; token: string };

const AsyncFunction = async function () {}.constructor as new (
  ...args: string[]
) => (itx: unknown, vars: Record<string, unknown>) => Promise<unknown>;

const BROWSER_EXAMPLES = ITX_EXAMPLES.filter(
  (example) => example.runtimes.includes("browser") && EXAMPLE_CASES[example.id] !== undefined,
);

const rid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!__ITX_BROWSER_E2E__.baseUrl)("itx browser execution mode", () => {
  for (const example of BROWSER_EXAMPLES) {
    const exampleCase = EXAMPLE_CASES[example.id]!;
    it(`runs catalogue example "${example.id}" in a browser tab`, async () => {
      const path = example.context === "agent" ? `/agents/browser-${rid}-${slug(example.id)}` : "/";
      const runCtx = { marker: `browser-${rid}`, projectId: "prj_ref" };

      // Setup runs over a browser-owned connection — the SAME runtime-agnostic
      // verb calls as Node, just from a tab. Sturdy addresses are plain data,
      // so the naked stub can provide them with no normalization.
      if (exampleCase.setup) {
        using setupItx = connectFromBrowser(path);
        await exampleCase.setup(setupItx);
      }

      using itx = connectFromBrowser(path);
      const script = new AsyncFunction("itx", "vars", example.code);
      const vars = exampleCase.vars?.(runCtx) ?? {};
      const result = await script(itx, vars);
      exampleCase.assert(result, runCtx);
    }, 120_000);
  }

  // The browser as a PROVIDER: a tab registers a live, browser-owned object
  // (closures that live in THIS tab) and the asserted value can only have been
  // computed by a call travelling back over the open session.
  it("provides a browser live cap and calls back into the tab", async () => {
    const path = `/agents/browser-${rid}-live-provider`;
    using itx = connectFromBrowser(path);
    let calls = 0;
    await itx.provideCapability({
      path: ["tab"],
      capability: {
        echo: (message: string) => {
          calls++;
          return { message, provider: "browser-tab" };
        },
      },
    });
    const result = (await (itx as any).tab.echo("hello from a browser tab")) as {
      message: string;
      provider: string;
    };
    expect(result).toEqual({ message: "hello from a browser tab", provider: "browser-tab" });
    expect(calls).toBe(1);
  }, 45_000);
});

function connectFromBrowser(path: string): any {
  const wsBase = __ITX_BROWSER_E2E__.baseUrl.replace(/^http/, "ws");
  const params = new URLSearchParams({ token: __ITX_BROWSER_E2E__.token });
  const session = newWebSocketRpcSession(new WebSocket(`${wsBase}/api/itx/prj_ref?${params}`));
  const target = path === "/" ? session : (session as any).agents.get(path).itx();
  return new Proxy(target, {
    get(target, key, receiver) {
      if (key === Symbol.dispose) return () => (session as any)[Symbol.dispose]?.();
      return Reflect.get(target, key, receiver);
    },
  });
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
