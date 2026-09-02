// rpc-stubs-bare-function-across-clients.e2e.test.ts — a live rpc stub may be a BARE FUNCTION; no
// RpcTarget subclass is needed (capnweb passes functions by reference as stubs). Jonas's snippet,
// verbatim in shape: a Node capnweb client provides an async function under `itx.runOnMyComputer`
// with the rewrite rule at the same spelling; ANOTHER client of the same context calls it with plain
// dotted syntax, and the call rides the provider's borrowed stub back into the provider's process.

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

test("client A: provide('itx.runOnMyComputer', async fn, rewrite) · client B: await itx.runOnMyComputer('ls', ['-la']) runs A's function", async () => {
  const ctx = freshCtx("barefn");
  const laptop = openItx(ctx);
  const otherClient = openItx(ctx);
  const ran: unknown[][] = [];
  await laptop.provide(
    "itx.runOnMyComputer",
    async (cmd: string, args: string[]) => {
      ran.push([cmd, args]);
      await new Promise((r) => setTimeout(r, 5)); // genuinely async, like execFile
      return `stdout of ${cmd} ${args.join(" ")}`;
    },
    { rewrite: "itx.runOnMyComputer" },
  );
  expect(await otherClient.runOnMyComputer("ls", ["-la"])).toBe("stdout of ls -la");
  expect(ran).toEqual([["ls", ["-la"]]]);
});
