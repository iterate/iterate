// A control-plane read that fails on the platform's side, twice, meets a live session's re-check.
// Its own file: the row waits the guard's real 30 s re-check, beside the other three
// (oauth-support.ts).
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { expect, onTestFinished, test, vi } from "vitest";
import { platformAddressesOf } from "../src/app-config.ts";
import { ControlPlane, ControlPlaneUnavailableError } from "../src/control-plane/edge.ts";
import { authorizationForToken } from "../src/oauth.ts";
import { rpcResponse } from "../src/rpc.ts";
import type { IterateRpcTarget } from "../src/session.ts";
import { fetchReachesThisWorker, grant } from "./oauth-support.ts";
import { ORIGIN, until } from "./support.ts";

test("a live session rides out control-plane reads that failed on the platform's side during its re-check: each is retried, and logged as the platform's failure", async () => {
  fetchReachesThisWorker();
  const flow = await grant([`${ORIGIN}/api`]);
  // THE GUARD FROM SOURCE (src/rpc.ts), not through `exports.default`: it serves the built worker, whose own
  // copy of ControlPlane a spy on the source class never sees. Same admission as /api's.
  const request = new Request(`${ORIGIN}/api`, {
    headers: { Upgrade: "websocket", Origin: ORIGIN },
  });
  const executionContext = createExecutionContext();
  const authorization = await authorizationForToken(
    env,
    flow.token!.access_token,
    platformAddressesOf(env, request),
    "api",
  );
  const response = await rpcResponse(request, env, executionContext, authorization);
  expect(response).toMatchObject({ status: 101 });
  response.webSocket!.accept();
  const transport = newWebSocketRpcSession<IterateRpcTarget>(
    response.webSocket! as unknown as WebSocket,
  );
  onTestFinished(() => {
    transport[Symbol.dispose]();
  });
  const root = transport.authenticate({ type: "from-server-cookie" });
  using context = await root.projects.get(flow.oauthA.id);
  await context.invoke("itx.kv.get('live-auth-probe')"); // holds the project: the tick reads membership
  // What Cloudflare's own deploy of D1 does to the tick's membership read (control-plane/edge.ts
  // `d1Fault`: retryable), then what an outage does to it (not retryable): the control plane is
  // down, not the session
  const membershipReads = vi
    .spyOn(ControlPlane.prototype, "reachableProjects")
    .mockImplementationOnce(() =>
      Promise.reject(
        new ControlPlaneUnavailableError({
          method: "accessibleTo",
          waitedMs: 40,
          cause: new Error("D1_ERROR: D1 DB reset because its code was updated."),
          retryable: true,
        }),
      ),
    )
    .mockImplementationOnce(() =>
      Promise.reject(
        new ControlPlaneUnavailableError({
          method: "accessibleTo",
          waitedMs: 12_000,
          cause: new Error("internal error; reference = workers-test"),
          retryable: false,
        }),
      ),
    );
  const warns = vi.spyOn(console, "warn");
  onTestFinished(() => {
    membershipReads.mockRestore();
    warns.mockRestore();
  });
  // Real elapsed time: the 30 s tick meets the reset, its retry 2 s later the outage, and the next
  // retry reads through.
  await until(
    "the re-check's retry reads through",
    () => membershipReads.mock.settledResults.some((result) => result.type === "fulfilled"),
    45_000,
  );
  const reads = membershipReads.mock.calls.length; // mockRestore clears the record
  membershipReads.mockRestore();
  expect(reads).toBeGreaterThanOrEqual(3);
  // each is a platform failure the fault alarm counts, retried all the same
  expect(warns).toHaveBeenCalledWith({
    event: "oauth.platform-failure-live-authorization-retry",
    name: "live-authorization",
    grantId: flow.token!.access_token.split(":")[1],
    message:
      "ControlPlaneUnavailableError: The control plane failed accessibleTo: D1_ERROR: D1 DB reset because its code was updated.",
  });
  expect(warns).toHaveBeenCalledWith({
    event: "oauth.platform-failure-live-authorization-retry",
    name: "live-authorization",
    grantId: flow.token!.access_token.split(":")[1],
    message:
      "ControlPlaneUnavailableError: The control plane failed accessibleTo: internal error; reference = workers-test",
  });
  expect(await root.whoami()).toMatchObject({ actor: flow.user.id });
  await context.invoke("itx.kv.get('live-auth-probe')"); // the project it holds still answers
});
