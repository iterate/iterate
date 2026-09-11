// rpc-inert-result-release.e2e — the edge may release only a settled outer native RPC promise whose
// actual result is inert plain data. `itx.build` is rewriteable, so this pins both sides: ordinary
// build/check data still arrives, while a rewritten build root can return a live capability that
// remains callable after crossing the same generic invoke door.

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

const source = {
  files: {
    "src/main.ts": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class App extends WorkerEntrypoint { fetch() { return new Response("ok"); } }`,
  },
  options: { entryPoint: "src/main.ts" },
};

test("releases inert build/check results but retains capabilities returned through rewritten itx.build", async () => {
  const itx = openItx(freshCtx("inert-result"));

  expect(await itx.check(source)).toEqual({ status: "checked", diagnostics: [] });
  expect(await itx.build(source)).toMatchObject({ status: "built" });

  class BuildCapability extends RpcTarget {
    ping(value: string): string {
      return `live:${value}`;
    }
  }
  class NestedCapability extends RpcTarget {
    ping(value: string): string {
      return `nested:${value}`;
    }
  }
  class Results extends RpcTarget {
    numbers(): number[] {
      return Array.from({ length: 50_000 }, (_, index) => index);
    }
    nested(): { capability: NestedCapability } {
      return { capability: new NestedCapability() };
    }
  }
  const provided = await itx.provide("itx.build", new BuildCapability());
  const aliased = await itx.provide("itx.alias", "itx.build");
  try {
    const direct = await itx.invoke("itx.build");
    expect(await direct.ping("direct")).toBe("live:direct");
    const throughAlias = await itx.invoke("itx.alias");
    expect(await throughAlias.ping("alias")).toBe("live:alias");

    const results = await itx.provide("itx.results", new Results());
    try {
      // This exceeds the proof budget. It is still valid data, so the normal retained-lifetime
      // path must return it unchanged.
      expect(await itx.invoke("itx.results.numbers()")).toHaveLength(50_000);
      // A nested capability makes the otherwise plain envelope uncertain; it must survive the
      // generic invoke result and remain callable instead of being released with its promise.
      const nested = await itx.invoke("itx.results.nested()");
      expect(await nested.capability.ping("value")).toBe("nested:value");
    } finally {
      results[Symbol.dispose]();
    }
  } finally {
    aliased[Symbol.dispose]();
    provided[Symbol.dispose]();
  }
});
