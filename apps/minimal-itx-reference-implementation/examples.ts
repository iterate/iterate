// The itx example catalogue: one data structure that the e2e suite runs across
// every execution runtime. Mirrors apps/os/src/itx/examples.ts. Each entry is a
// self-contained script body that runs with `itx` and `vars` in scope and uses
// an explicit `return` — exactly the shape every runtime accepts:
//
//   node            AsyncFunction("itx", "vars", code) on a Cap'n Web stub
//   cli             a spawned `cli.ts run --code <code>` (same Node eval)
//   post-script     POST /api/itx, loaded inside workerd by runScript
//   dynamic-worker  a Worker Loader isolate with env.ITX.get()
//   browser         a real Chromium tab over a browser WebSocket
//
// Everything test-only — how a context is set up, the `vars` a body gets, and
// the result assertions — lives in example-cases.ts, so this stays pure data.
// `runtimes` records where a snippet genuinely works unattended; the matrix
// honors it.

export const ITX_EXAMPLE_RUNTIMES = [
  "browser",
  "node",
  "cli",
  "post-script",
  "dynamic-worker",
] as const;

export type ItxExampleRuntime = (typeof ITX_EXAMPLE_RUNTIMES)[number];

export type ItxExample = {
  /** Script body: `itx` and `vars` in scope, explicit `return`. */
  code: string;
  /** The coordinate the snippet expects: an agent context (which inherits the
   *  project's built-ins) or the project root itself. */
  context: "agent" | "project";
  description: string;
  id: string;
  /** Runtimes the snippet runs unattended in (the e2e matrix honors this). */
  runtimes: ItxExampleRuntime[];
  title: string;
};

const ALL_RUNTIMES: ItxExampleRuntime[] = [...ITX_EXAMPLE_RUNTIMES];

export const ITX_EXAMPLES: ItxExample[] = [
  {
    id: "agent-builtin",
    title: "Call an agent's own built-in",
    description:
      "Every context is born with built-in capabilities from the domain object it attaches to. An agent context's Agent DO defines `whoami`; the same dotted call collapses to one invokeCapability in every runtime.",
    context: "agent",
    runtimes: ALL_RUNTIMES,
    code: `return await itx.whoami();`,
  },
  {
    id: "project-builtin-inherited",
    title: "Reach a project built-in inherited by an agent",
    description:
      "An agent context's parent is its project context, so the project's `repo` built-in resolves through the chain without the agent providing anything.",
    context: "agent",
    runtimes: ALL_RUNTIMES,
    code: `
      const source = await itx.repo.getWorkerSource({ path: "counter.js" });
      return {
        mainModule: source.mainModule,
        hasCounter: source.modules["counter.js"].includes("CounterDurableObject"),
      };
    `,
  },
  {
    id: "dynamic-worker-capability",
    title: "Call a provided dynamic-worker capability",
    description:
      "A sturdy capability (an address, not a live stub) is dialed from the event log on demand: the Worker Loader runs the isolate and its method answers. `vars` parameterizes the call.",
    context: "agent",
    runtimes: ALL_RUNTIMES,
    code: `return await itx.calc.add(vars.a, vars.b);`,
  },
  {
    id: "dynamic-durable-object-facet",
    title: "Increment a dynamic Durable Object facet",
    description:
      "A repo-sourced Durable Object mounted as a capability keeps private SQLite storage keyed by its mount path, so increments persist across calls within a context.",
    context: "agent",
    runtimes: ALL_RUNTIMES,
    code: `
      const next = await itx.counter.increment();
      const current = await itx.counter.current();
      return { current, next };
    `,
  },
];
