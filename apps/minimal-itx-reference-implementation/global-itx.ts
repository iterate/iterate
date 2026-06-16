// global-itx.ts — the __global__ platform capability root.
//
// The chain bottoms out here: every project context's parent, and itself
// parentless. It is the ONE context that is NOT a Durable Object and NOT a
// StreamProcessor — there is no stream to fold and nothing to persist, so it is
// just CONSTRUCTED IN CODE (per connection) and answers the SAME `ItxContext`
// protocol as any other context. Two properties make it "the root":
//
//   • READ-ONLY: `provideCapability` / `revokeCapability` throw. You cannot
//     append to a context that has no log — so "you cannot provide into the
//     root" is structural, not a guard someone must remember.
//   • NO PARENT: a capability miss has nowhere left to climb, so it throws.
//
// Its capabilities are fixed, project-agnostic "catalog" caps wired in as code:
// a single `projects` cap (a `{ list, get }`). Adding a sibling (`users`,
// `orgs`, …) is just another entry — which is the whole reason the catalog rides
// the capability protocol instead of being bespoke handle code.
//
// The WebSocket route still serves it through pathCallable so the global root,
// project contexts, agent contexts, and codemode handles all share one dotted
// call rule: every terminal call becomes invokeCapability({ path, args }).

import { RpcTarget } from "capnweb";
import { KNOWN_PROJECTS } from "./auth.ts";
import { ITX_CONTROL_NAMES, type DescribeResult, type ItxContext, replayPath } from "./itx.ts";

class GlobalProjects extends RpcTarget {
  constructor(readonly reachable: () => string[]) {
    super();
  }

  list() {
    return this.reachable();
  }

  get(id: string) {
    if (!this.reachable().includes(id)) throw new Error(`no access to project "${id}"`);
    // Production narrows to a live project itx HANDLE here; the reference impl
    // returns the project's context ref (the narrowing target) to stay simple.
    return { id, ref: `prj:${id}` };
  }
}

export class GlobalItx extends RpcTarget implements ItxContext {
  #access: "all" | string[];
  #projects: GlobalProjects;
  // The fixed catalog. The `projects` cap is also exposed as a real RpcTarget
  // getter so the __global__ Cap'n Web path does not need pathCallable.
  #capabilities: Record<string, unknown>;

  constructor(args: { access: "all" | string[] }) {
    super();
    this.#access = args.access;
    const reachable = () => (this.#access === "all" ? KNOWN_PROJECTS : this.#access);
    this.#projects = new GlobalProjects(reachable);
    this.#capabilities = {
      projects: this.#projects,
    };
  }

  get projects() {
    return this.#projects;
  }

  // Read side: longest registered prefix wins, then replay the remainder onto the
  // resolved cap — the same primitive `Itx` uses. The root has NO parent, so a
  // miss bottoms out here.
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

    for (let i = path.length; i >= 1; i--) {
      const cap = this.#capabilities[path.slice(0, i).join(".")];
      if (cap) return await replayPath(cap, path.slice(i), args);
    }
    throw new Error(
      `no capability "${path.join(".")}" (the __global__ root context has no parent)`,
    );
  }

  // Same `DescribeResult` shape as any context (enforced by `implements
  // ItxContext`), so it nests under a child's `parentCapabilities` uniformly —
  // except the root has no fold, so `capabilities` is empty and there is no
  // parent. Its `projects` catalog is reported as a built-in, listed the same way
  // a project lists its `fetch` or an agent its `whoami`.
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
