// perf/sign-in-and-mcp.perf.test.ts — THE WAYS A PERSON AND AN AGENT SIGN IN: a new person's
// password sign-in (the sign-in page's own `POST /login`, a find-or-create on the control plane,
// answered with the session cookie — support/principal.ts `issuerCookie`), and an MCP tool call with a
// personal access token (the `run` tool, `itx.whoami()`, as session.e2e's grant row makes it). Each
// is timed sequentially on its own, with nothing else on the wire.

import { newHttpBatchRpcSession } from "capnweb";
import { expect, test } from "vitest";
import type { IterateRpcTarget } from "../src/session.ts";
import { mcpCall, workerUrl } from "../e2e/support/client.ts";
import { issuerCookie, oauthSession } from "../e2e/support/principal.ts";
import { freshDnsSafeProjectSlug, registerProject } from "../e2e/support/project-host.ts";
import { recordLatency } from "./record.ts";

test("a new person's password sign-in answers with a session", async ({ task }) => {
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    const email = `${freshDnsSafeProjectSlug("signin")}@example.com`;
    const started = performance.now();
    const cookie = await issuerCookie(email);
    samples.push(performance.now() - started);
    expect(cookie).not.toBe("");
  }
  recordLatency(task, "sign-in", samples);
});

test("an MCP tool call on a project, with a personal access token", async ({ task }) => {
  const slug = freshDnsSafeProjectSlug("mcp");
  const member = { email: `${slug}@example.com` };
  const projectId = await registerProject(slug, member);
  const { issuerHeaders } = await oauthSession(projectId, member);
  // oxlint-disable-next-line iterate/no-capnweb-http-batch -- One bounded token mint through the account API, as session.e2e's grant row mints it.
  using minter = newHttpBatchRpcSession<IterateRpcTarget>(
    new Request(workerUrl("/api"), { headers: issuerHeaders }),
  );
  const { token } = await minter
    .authenticate({ type: "from-server-cookie" })
    .grants.mint({ name: "perf MCP call", projects: [projectId], resource: "mcp" });
  const call = () =>
    mcpCall(
      "tools/call",
      { name: "run", arguments: { script: "async (itx) => itx.whoami()" } },
      token,
    );
  // the first call loads the run tool's worker: warm it, as an agent's session would be
  expect(JSON.stringify(await call())).toContain(projectId);
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    const result = await call();
    samples.push(performance.now() - started);
    expect(result).toMatchObject({ isError: false });
  }
  recordLatency(task, "mcp.call", samples);
});
