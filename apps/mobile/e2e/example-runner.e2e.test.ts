// Live proof that the app's own capabilityHost.runScript call (see
// app/project/[projectId]/examples.tsx) actually runs a real catalogue
// example against a real project, from Node — same seam-split precedent as
// chat-roundtrip.e2e.test.ts: dialItx (itx-core.ts, Expo-free) over a real
// capnweb WebSocket with a bearer token.
//
//   doppler run --config dev -- pnpm --dir apps/mobile test:e2e   # local dev (pnpm dev must be running)

import { expect, test } from "vitest";
import { newWebSocketRpcSession } from "capnweb";
import { mintForgedAccessToken } from "../../../scripts/auth/forge-token.ts";
import type { UnauthenticatedOs } from "../../os/src/itx-api.generated.ts";
import { phoneRunnableExamples } from "../src/lib/examples.ts";
import { dialItx } from "../src/lib/itx-core.ts";
import { portlessOrigin, requireEnv, resolveBaseUrl, wsUrl } from "./e2e-helpers.ts";

test("phone example runner: egress-rules-configured runs for real against a real project", async () => {
  const baseUrl = resolveBaseUrl();

  const admin = newWebSocketRpcSession<UnauthenticatedOs>(wsUrl(baseUrl));
  const adminSession = await admin.authenticate({
    type: "admin-secret",
    secret: requireEnv("APP_CONFIG_ADMIN_API_SECRET"),
  });
  const slug = `mobile-examples-e2e-${Date.now().toString(36)}`;
  const created = await adminSession.projects.create({ slug });
  const { projectId } = await created.__describe();

  const token = await mintForgedAccessToken({
    forgePrivateJwk: requireEnv("AUTH_FORGE_PRIVATE_JWK"),
    issuer: requireEnv("APP_CONFIG_ITERATE_AUTH__ISSUER"),
    audience: process.env.APP_CONFIG_ITERATE_AUTH__RESOURCE?.trim() || portlessOrigin(baseUrl),
    email: "mobile-examples-e2e@nustom.com",
    admin: true,
  });
  const itx = await dialItx(baseUrl, async () => token);
  const project = await itx.projects.get(projectId);
  const example = phoneRunnableExamples().find(
    (candidate) => candidate.id === "egress-rules-configured",
  )!;
  const execution = await project.capabilityHost.runScript(
    `async (itx) => {\nconst vars = {};\n${example.code}\n}`,
  );

  expect(execution.result).toMatchObject({
    host: "httpbin.org",
    offset: expect.any(Number),
    ruleKey: "repl-demo-hold",
  });
});

test("the phone-runnable filter matches what the runner can actually execute", () => {
  // Every entry the app would list must be runnable through this exact
  // door (capabilityHost.runScript) — a stale filter (e.g. after the
  // catalogue adds a new context/runtime combo) would show a "Run" button
  // that fails, so this is a plain assertion, not a live call.
  for (const example of phoneRunnableExamples()) {
    expect(example.context).toBe("project");
    expect(example.runtimes).toContain("run-script");
  }
});
