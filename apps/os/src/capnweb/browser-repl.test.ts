import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_BROWSER_REPL_CODE, evalBrowserReplCode } from "./browser-repl.ts";
import { liftLocalProxies } from "./local-proxy-wrapper.js";

describe("browser Cap'n Web REPL", () => {
  test("default snippet uses Cap'n Web promise pipelining", async () => {
    const list = vi.fn().mockResolvedValue({ items: [{ id: "proj_123" }] });
    class Projects extends RpcTarget {
      list(input: { limit: number }) {
        return list(input);
      }
    }

    class Context extends RpcTarget {
      get projects() {
        return new Projects();
      }
    }

    const ctx = liftLocalProxies(new RpcStub(new Context()));

    await expect(evalBrowserReplCode({ code: DEFAULT_BROWSER_REPL_CODE, ctx })).resolves.toEqual({
      items: [{ id: "proj_123" }],
    });
    expect(list).toHaveBeenCalledWith({ limit: 5 });
  });
});
