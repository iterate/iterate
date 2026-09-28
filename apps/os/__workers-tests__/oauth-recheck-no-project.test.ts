// A socket that holds no project. Its own file: the row waits the guard's real 30 s re-check,
// beside the other three (oauth-support.ts).
import { expect, test, vi } from "vitest";
import { ControlPlane } from "../src/control-plane/edge.ts";
import { grant, rpc } from "./oauth-support.ts";
import { fetchReachesThisWorker, ORIGIN } from "./support.ts";

test("a socket holding no project re-checks its grant every thirty seconds and reads no membership", async () => {
  fetchReachesThisWorker();
  const flow = await grant([`${ORIGIN}/api`]);
  const { root } = await rpc(flow.token!.access_token);
  expect(await root.whoami()).toMatchObject({ actor: flow.user.id });
  // The worker under test runs in this isolate: the guard's membership read (rpc.ts —
  // `controlPlane.reachableProjects`, the one read behind every reach check) passes this spy.
  const membershipReads = vi.spyOn(ControlPlane.prototype, "reachableProjects");
  // Real elapsed time: one tick of the deployed 30 s interval, nothing test-only.
  await new Promise((resolve) => setTimeout(resolve, 31_000));
  membershipReads.mockRestore();
  // Every socket in this test holds no project (this one, and `grant()`'s issuer session that
  // approved the consent): each tick reads its grant on the account and no membership at all.
  expect(membershipReads).not.toHaveBeenCalled();
  expect(await root.whoami()).toMatchObject({ actor: flow.user.id }); // still live: it holds nothing to lose
});
