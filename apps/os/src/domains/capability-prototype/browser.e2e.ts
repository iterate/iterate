import { expect, test } from "vitest";
import { commands } from "vitest/browser";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";

import type { FakeIterateCapability } from "./capability.ts";
import { appendAndRead, type PrototypeScript, type PrototypeScriptInput } from "./scripts.ts";

declare const __CAPABILITY_PROTOTYPE_BROWSER_E2E__: {
  adminApiSecret: string;
  baseUrl: string;
};

test("prototype root capability code has an in-browser runner", async () => {
  using ctx = await connectPrototypeContextFromBrowser();
  const projectId = `fake_proj_browser_${crypto.randomUUID().slice(0, 8)}`;
  const marker = `browser-${crypto.randomUUID().slice(0, 8)}`;
  const streamPath = "/prototype/browser";
  const eventType = "events.iterate.test/prototype-browser";

  await expect(
    runPrototypeBrowserScript({
      ctx,
      script: appendAndRead,
      vars: {
        eventType,
        marker,
        projectId,
        source: "browser",
        streamPath,
      },
    }),
  ).resolves.toMatchObject({
    appended: {
      marker,
      projectId,
      source: "browser",
      streamPath,
      type: eventType,
    },
    project: {
      id: projectId,
    },
  });
});

async function runPrototypeBrowserScript(input: {
  ctx: RpcStub<FakeIterateCapability>;
  script: PrototypeScript;
  vars: PrototypeScriptInput["vars"];
}) {
  const script = evalPrototypeScript(input.script.toString());
  return await script({
    ctx: input.ctx,
    vars: input.vars,
  });
}

function evalPrototypeScript(source: string): PrototypeScript {
  return (0, eval)(`(${source})`) as PrototypeScript;
}

async function connectPrototypeContextFromBrowser(): Promise<RpcStub<FakeIterateCapability>> {
  if (!__CAPABILITY_PROTOTYPE_BROWSER_E2E__.adminApiSecret) {
    throw new Error("APP_CONFIG_ADMIN_API_SECRET is required for browser e2e tests.");
  }
  await setCapabilityPrototypeAdminCookie(
    new URL("/api/capability-prototype/admin-cookie", baseUrl()),
  );
  const wsUrl = new URL("/api/capability-prototype", baseUrl());
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<FakeIterateCapability>(new WebSocket(wsUrl));
}

async function setCapabilityPrototypeAdminCookie(url: URL) {
  const result = await (commands as any).setCapabilityPrototypeAdminCookie({
    secret: __CAPABILITY_PROTOTYPE_BROWSER_E2E__.adminApiSecret,
    url: url.toString(),
  });
  if (!result.cookies?.some((cookie: { name: string }) => cookie.name === "iterate-admin-auth")) {
    throw new Error(`iterate-admin-auth cookie was not installed for ${url.origin}`);
  }
}

function baseUrl() {
  if (!__CAPABILITY_PROTOTYPE_BROWSER_E2E__.baseUrl) {
    throw new Error("APP_CONFIG_BASE_URL is required for capability prototype browser e2e tests.");
  }
  return __CAPABILITY_PROTOTYPE_BROWSER_E2E__.baseUrl;
}
