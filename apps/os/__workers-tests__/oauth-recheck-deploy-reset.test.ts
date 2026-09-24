// A deploy's Durable Object reset, then a control-plane outage, meet a live session's re-check. Its
// own file: the row waits the guard's real 30 s re-check, beside the other three (oauth-support.ts).
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

test("a live session rides out a deploy's Durable Object reset, and a control-plane read that gave up, during its re-check", async () => {
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
  // What a deploy does to the tick's membership read (prd, 2026-09-23 after #2888): the control
  // plane's Durable Object is reset for its new code and workerd stamps the cut call retryable.
  const membershipReads = vi
    .spyOn(ControlPlane.prototype, "reachableProjects")
    .mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error("Durable Object reset because its code was updated."), {
          retryable: true,
          durableObjectReset: true,
        }),
      ),
    )
    // then what an outage does to it: the edge's bounded read gives up (control-plane/edge.ts),
    // which no transport flag marks — the control plane is down, not the session
    .mockImplementationOnce(() =>
      Promise.reject(
        new ControlPlaneUnavailableError({
          method: "accessibleTo",
          waitedMs: 3_000,
          boundMs: 3_000,
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
  // a deploy's reset is expected, never a platform failure the prd fault alarm counts
  expect(warns).toHaveBeenCalledWith({
    event: "oauth.deploy-reset-live-authorization-retry",
    name: "live-authorization",
    grantId: flow.token!.access_token.split(":")[1],
    message: "Error: Durable Object reset because its code was updated.",
  });
  // the outage's is a platform failure the fault alarm counts, retried all the same
  expect(warns).toHaveBeenCalledWith({
    event: "oauth.platform-failure-live-authorization-retry",
    name: "live-authorization",
    grantId: flow.token!.access_token.split(":")[1],
    message:
      "ControlPlaneUnavailableError: The control plane did not answer accessibleTo within 3000 ms",
  });
  expect(await root.whoami()).toMatchObject({ actor: flow.user.id });
  await context.invoke("itx.kv.get('live-auth-probe')"); // the project it holds still answers
});
