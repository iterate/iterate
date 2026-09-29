// __workers-tests__/config-entrypoint.test.ts — what a caller reaches on a loaded
// `IterateConfigEntrypoint` (iterate/sdk). Its `withItx` hands a callback the scope of the context
// that loaded it, so were it a method, anyone who can load the entrypoint could have their callback
// run with that context's reach: it answers as a method Workers RPC would not reach.
import { expect, test } from "vitest";
import { adminCredentials, openSession } from "./support.ts";

/** A config entrypoint with nothing of its own. */
const CONFIG_ENTRYPOINT = {
  "package.json": '{"main":"worker.js"}',
  "worker.js":
    'import { IterateConfigEntrypoint } from "iterate/sdk";\nexport default class extends IterateConfigEntrypoint {}\n',
};

test.for([
  {
    name: "from a session",
    call: (itx: any) =>
      itx.invoke(["itx", "workers", ["get", { source: CONFIG_ENTRYPOINT }], ["withItx", "x"]]),
  },
  {
    name: "from loaded code",
    call: (itx: any) =>
      itx.run(
        `async (itx) => itx.workers.get(${JSON.stringify({ source: CONFIG_ENTRYPOINT })}).withItx("x")`,
      ),
  },
])("a config entrypoint's withItx is no RPC method, $name", async ({ call }) => {
  const itx = await (
    await openSession()
  )
    .authenticate(adminCredentials())
    .projects.get("prj_config_entrypoint");
  await expect(call(itx)).rejects.toThrow(/withItx is no method Workers RPC would reach/);
});
