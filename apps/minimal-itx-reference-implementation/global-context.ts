// global-context.ts — the platform capability root.
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
// `implements ItxContext` is load-bearing: it forces this hand-written root to
// answer exactly the same protocol as `Itx`, so the two cannot drift.

import { KNOWN_PROJECTS } from "./auth.ts";
import { type DescribeResult, type ItxContext, replayPath } from "./itx.ts";

export class GlobalContext implements ItxContext {
  #access: "all" | string[];
  // The fixed catalog. ONE cap `projects` whose deep path (projects.list /
  // projects.get(id)) replays onto this plain object — the exact same deep-path
  // shape any mounted live object uses.
  #capabilities: Record<string, unknown>;

  constructor(args: { access: "all" | string[] }) {
    this.#access = args.access;
    const reachable = () => (this.#access === "all" ? KNOWN_PROJECTS : this.#access);
    this.#capabilities = {
      projects: {
        list: () => reachable(),
        get: (id: string) => {
          if (!reachable().includes(id)) throw new Error(`no access to project "${id}"`);
          // Production narrows to a live project itx HANDLE here; the reference
          // impl returns the project's context ref (the narrowing target) to stay
          // naked-stub simple.
          return { id, ref: `prj:${id}` };
        },
      },
    };
  }

  // Read side: longest registered prefix wins, then replay the remainder onto the
  // resolved cap — the same primitive `Itx` uses. The root has NO parent, so a
  // miss bottoms out here.
  async invokeCapability({ path, args = [] }: { path: string[]; args?: unknown[] }) {
    for (let i = path.length; i >= 1; i--) {
      const cap = this.#capabilities[path.slice(0, i).join(".")];
      if (cap) return await replayPath(cap, path.slice(i), args);
    }
    throw new Error(`no capability "${path.join(".")}" (the global root context has no parent)`);
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
    };
  }

  // READ-ONLY — there is no log to append to.
  async provideCapability(): Promise<never> {
    throw new Error(
      "the global root context is stateless and read-only — you cannot provide a capability into it",
    );
  }
  async revokeCapability(): Promise<never> {
    throw new Error(
      "the global root context is stateless and read-only — there is nothing to revoke",
    );
  }
}
