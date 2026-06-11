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
 * The defaults every project context delegates to (§8's "cap #0 disappears"
 * direction). What was hardwired into the handle is now ordinary capability
 * definitions: ai, fetch, streams, repos, workspace, and the project
 * worker. The remaining kernel — caps, fork, project, projects, describe,
 * plus the GLOBAL streams namespace — is composition the registry cannot
 * express (access checks, narrowing, the registry itself).
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
  caps.define({
    // The DEFAULT egress pipe: itx.fetch(...) and bare fetch() in every
    // platform-loaded isolate dispatch through THIS registry entry. The
    // target is the terminal ProjectEgress.call (path: [], args: [request])
    // → the Project DO's egressFetch — dialing .call, not .fetch, is what
    // breaks the loop, because ProjectEgress.fetch routes registry-first.
    invoke: "path-call",
    meta: {
      instructions:
        "Project egress: itx.fetch(request) and bare fetch() inside platform-loaded " +
        "isolates both flow through this cap. Shadow it with your own `fetch` (e.g. a " +
        "live provider whose call({ path: [], args: [request] }) returns a Response) to " +
        "intercept ALL project egress while connected; revoke the shadow and this " +
        "default resurfaces. A shadow provider receives getSecret(...) placeholders " +
        "UNSUBSTITUTED — secret material only exists in the default pipe inside the " +
        "Project DO.",
    },
    name: "fetch",
    target: {
      entrypoint: "ProjectEgress",
      type: "rpc",
      worker: { type: "loopback" },
    },
  });
  caps.define({
    meta: {
      instructions:
        "Event streams in this project's namespace: itx.streams.get('/path') returns a " +
        "stream handle with append/read/getState/subscribe; get also takes absolute " +
        "refs ('ns:/path') checked against this project's access. Chained calls ride " +
        "RPC promise pipelining.",
    },
    name: "streams",
    target: {
      entrypoint: "StreamsCap",
      type: "rpc",
      worker: { type: "loopback" },
    },
  });
  caps.define({
    meta: {
      instructions:
        "The project's git repos: itx.repos.ensureIterateConfigInfo({ projectSlug }), " +
        "list(), create({ slug }), get({ slug }) — repo handles expose commitFiles/readFiles/readLog.",
    },
    name: "repos",
    target: {
      entrypoint: "ReposCapability",
      type: "rpc",
      worker: { type: "loopback" },
    },
  });
  caps.define({
    meta: {
      instructions:
        "A persistent workspace filesystem: itx.workspace.readFile/writeFile plus the flat " +
        "git methods gitClone/gitAdd/gitCommit/gitPush/gitStatus. Project contexts share " +
        "one workspace; forked child contexts each get their own.",
    },
    name: "workspace",
    target: {
      entrypoint: "WorkspaceCapability",
      type: "rpc",
      worker: { type: "loopback" },
    },
  });
  caps.define({
    // path-call: the cap's own invoke describes the forwarder hop; the
    // members replay against the user's default export rides in props.
    invoke: "path-call",
    meta: {
      instructions:
        "The project's own iterate-config worker, rebuilt from the repo on every call: " +
        "itx.worker.someExportedFunction(args) reaches any public method of its default export.",
    },
    name: "worker",
    target: {
      entrypoint: "ProjectWorker",
      props: { invoke: "members" },
      type: "rpc",
      worker: { type: "loopback" },
    },
  });
});
