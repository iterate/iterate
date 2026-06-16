// global-itx.ts — the __global__ platform capability root.
//
// The chain bottoms out here: every project context's `itxParent`, and itself
// parentless. It is the ONE context that is NOT a Durable Object and NOT a
// StreamProcessor — there is no stream to fold and nothing to persist, so it is
// just CONSTRUCTED IN CODE (per connection) and answers the SAME `ItxContext`
// protocol as any other context. Two properties make it "the root":
//
//   • READ-ONLY: `provideCapability` / `revokeCapability` throw. You cannot
//     append to a context that has no log — so "you cannot provide into the
//     root" is structural, not a guard someone must remember.
//   • NO ITX PARENT: a capability miss has nowhere left to climb, so it throws.
//
// Its capabilities are fixed, project-agnostic "catalog" caps wired in as code.
// A single `projects` cap exposes `{ list, get }`.
//
// The WebSocket route still serves it through pathProxyToInvokeCapability so
// the global root, project contexts, agent contexts, and codemode handles all
// share one dotted call rule: every terminal call becomes
// invokeCapability({ path, args }).

import { KNOWN_PROJECTS } from "./auth.ts";
import { ITX_CONTROL_NAMES, type DescribeResult, type ItxContext, replayPath } from "./itx.ts";

export class GlobalItx implements ItxContext {
  #access: "all" | string[];

  constructor(args: { access: "all" | string[] }) {
    this.#access = args.access;
  }

  #reachable() {
    return this.#access === "all" ? KNOWN_PROJECTS : this.#access;
  }

  // Read side: longest registered prefix wins, then replay the remainder onto the
  // resolved cap — the same primitive `Itx` uses. The root has no `itxParent`,
  // so a miss bottoms out here.
  async invokeCapability({
    path,
    args = [],
  }: {
    path: string[];
    args?: unknown[];
  }): Promise<unknown> {
    const control = path[0];
    if (control && ITX_CONTROL_NAMES.has(control)) {
      if (path.length !== 1) throw new Error(`reserved ITX control path "${control}"`);
      switch (control) {
        case "provideCapability":
          return await this.provideCapability();
        case "invokeCapability":
          return await this.invokeCapability(args[0] as { path: string[]; args?: unknown[] });
        case "revokeCapability":
          return await this.revokeCapability();
        case "describe":
          return await this.describe();
      }
    }

    if (path[0] === "projects") {
      return await replayPath(
        {
          list: () => this.#reachable(),
          get: (id: string) => {
            if (!this.#reachable().includes(id)) throw new Error(`no access to project "${id}"`);
            // Production narrows to a live project itx HANDLE here; the reference
            // impl returns the project's context ref to stay simple.
            return { id, ref: `${id}:/` };
          },
        },
        path.slice(1),
        args,
      );
    }
    throw new Error(
      `no capability "${path.join(".")}" (the __global__ root context has no itxParent)`,
    );
  }

  // Same `DescribeResult` shape as any context (enforced by `implements
  // ItxContext`). The root has no fold and no `itxParent` built-in, so
  // `capabilities` is empty and `builtins` contains only the project catalog.
  async describe(): Promise<DescribeResult> {
    return {
      capabilities: [],
      builtins: [
        {
          path: ["projects"],
          address: null,
          instructions:
            "the project catalog: list() what you can reach, get(id) to narrow into one",
          types: null,
        },
      ],
      scriptExecutions: [],
    };
  }

  // READ-ONLY — there is no log to append to.
  async provideCapability(): Promise<never> {
    throw new Error(
      "the __global__ root context is stateless and read-only — you cannot provide a capability into it",
    );
  }
  async revokeCapability(): Promise<never> {
    throw new Error(
      "the __global__ root context is stateless and read-only — there is nothing to revoke",
    );
  }
}
