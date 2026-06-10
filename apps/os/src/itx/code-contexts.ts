// Code contexts (itx-next.md §8): platform default capabilities are a
// PARENT CONTEXT written in code instead of SQLite rows. A named,
// addressable, shadowable collection of caps that lookup falls through to is
// what a context is — so the defaults need no new concept, just a chain link
// that resolves in-process:
//
//   ctx_session → prj_123 → platform:project (this module) → global
//
// Law 1 said it all along: code holds composition — defaults are
// composition; only overrides are data. A project's own rows shadow these
// (prototype semantics), describe() reports them with the code context's
// name as owner, and shipping a new platform default is a deploy, not a
// migration of thousands of registries.

import {
  assertDefinableCapTarget,
  assertValidCapName,
  type CapInvoke,
  type CapMeta,
  type SerializableCapTarget,
} from "./protocol.ts";

export type CodeContextCap = {
  invoke: CapInvoke;
  meta: CapMeta;
  target: SerializableCapTarget;
};

export type CodeContext = {
  /** The context's name — describe() provenance (`owner`) for its caps. */
  name: string;
  caps: ReadonlyMap<string, CodeContextCap>;
};

/**
 * The authoring surface: the same verbs as a REPL snippet, executed once at
 * module init against an in-memory registry. Targets are validated eagerly —
 * a bad platform default should fail the deploy, not the first dial.
 */
export function defineCodeContext(
  name: string,
  build: (caps: {
    define(input: {
      name: string;
      target: SerializableCapTarget;
      invoke?: CapInvoke;
      meta?: CapMeta;
    }): void;
  }) => void,
): CodeContext {
  const caps = new Map<string, CodeContextCap>();
  build({
    define(input) {
      assertValidCapName(input.name);
      assertDefinableCapTarget(input.name, input.target);
      if (caps.has(input.name)) {
        throw new Error(`Code context "${name}" defines "${input.name}" twice.`);
      }
      caps.set(input.name, {
        invoke: input.invoke ?? "members",
        meta: input.meta ?? {},
        target: input.target,
      });
    },
  });
  return { caps, name };
}

/**
 * The defaults every project context delegates to. Deliberately small to
 * start: `ai` is the first hardwired built-in to become an ordinary
 * capability definition (§8's "cap #0 disappears" direction — repos,
 * workspace, and streams follow as their handle accessors migrate).
 */
export const platformProjectContext = defineCodeContext("platform:project", (caps) => {
  caps.define({
    invoke: "path-call",
    meta: {
      instructions:
        "Workers AI. Use it like an env.AI binding: itx.ai.run(model, inputs). " +
        "Shadow it with your own `ai` cap to swap providers.",
    },
    name: "ai",
    target: {
      entrypoint: "BindingCapability",
      props: { binding: "AI" },
      type: "rpc",
      worker: { type: "loopback" },
    },
  });
});
