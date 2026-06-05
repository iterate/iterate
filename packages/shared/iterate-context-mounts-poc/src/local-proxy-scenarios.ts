import type { createLocalCtxProxy } from "./local-proxy.ts";

type LocalCtx = ReturnType<typeof createLocalCtxProxy>;

export async function runLocalProxyScenario(name: string, ctx: LocalCtx) {
  switch (name) {
    case "all-mounts": {
      const viaFunction = await ctx.someMethod({ reason: "proxy" });
      const viaNested = await ctx.something.someMethod({ value: 9 });
      const viaDispatch = await ctx.some.chat.postMessage({ channel: "C1", text: "proxy" });
      return { viaFunction, viaNested, viaDispatch };
    }
    case "iterate-callback": {
      await ctx.streams.get("/proof").append({
        type: "proof.event",
        payload: { marker: "from-baked-in" },
      });
      const fromMount = await ctx.someMethod({ marker: "from-mount-worker" });
      const events = await ctx.streams.read({
        streamPath: "/current",
        afterOffset: "start",
      });
      return { fromMount, eventCount: events.length };
    }
    default:
      throw new Error(`Unknown local proxy scenario: ${name}`);
  }
}
