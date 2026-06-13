// The defaults: the code-rooted FINAL LINK of every project's
// capability chain (itx-next.md, "LOCKED: the final shape" — "Defaults live
// on the parent chain; the root of every chain is code").
//
//   <prj>:/itx/<x> → <prj>:/ → platform:project (THIS, code)
//
// There is exactly ONE capability map per context; the defaults are
// not a layer inside any instance — they are this context's provides,
// reached by ordinary chain delegation. Shadowing, revoke-resurfaces-
// the-default, and deploy-updates are consequences of the chain, not rules:
// a project's own row wins because lookup never reaches this link; revoking
// it makes lookup reach here again; a deploy changes this code, so every
// chain sees the new defaults immediately.
//
// Read-only, by nature: invoke/describe answer from code; provide/revoke
// refuse — everything WRITABLE is durable, and this context is not writable.
// Addressed `{ type: "rpc", worker: { type: "loopback" }, entrypoint:
// "PlatformContext" }` and dialed in-process (ctx.exports), so default
// dispatch pays no Durable Object hop.

import { WorkerEntrypoint } from "cloudflare:workers";
import {
  resolveLongestProvidedPrefix,
  type CapabilityAddress,
  type CapabilityDescription,
  type ItxOrigin,
  type ItxStub,
  type ProvideCapabilityInput,
} from "./itx.ts";
import { makeDial, resolveDialableTargets } from "./dial.ts";
import { contextAddress, projectContextRef } from "./coordinates.ts";
import { parseConfig } from "~/config.ts";

export const PLATFORM_PROJECT_CONTEXT_ID = "platform:project";

/**
 * The project worker's source: the code in the project's own config repo,
 * addressed like ANY repo-sourced capability. "latest" tracks pushes; the
 * build is memoized per commit (source-build.ts). HTTP ingress and event
 * forwarding load the same source (domains/projects/project-worker-runtime.ts).
 */
export const PROJECT_WORKER_SOURCE = {
  bundle: {},
  commit: "latest",
  path: "worker.js",
  repo: "project",
  type: "repo",
} as const satisfies import("./itx.ts").WorkerSource;

/** The defaults context's own address — pure code behind a loopback name. */
export const PLATFORM_PROJECT_CONTEXT_ADDRESS: CapabilityAddress = {
  entrypoint: "PlatformContext",
  type: "rpc",
  worker: { type: "loopback" },
};

type PlatformCapability = {
  name: string;
  instructions: string;
  address: CapabilityAddress;
};

/**
 * The defaults every project context inherits — literal, legible entries;
 * shipping a new default is a deploy, not a migration of thousands of
 * journals. Child contexts inherit them through the chain via the project.
 */
const PLATFORM_PROJECT_CAPABILITIES: PlatformCapability[] = [
  {
    address: {
      entrypoint: "BindingCapability",
      props: { binding: "AI" },
      type: "rpc",
      worker: { type: "loopback" },
    },
    instructions:
      "Workers AI. Use it like an env.AI binding: itx.ai.run(model, inputs). " +
      "Shadow it with your own `ai` cap to swap providers.",
    name: "ai",
  },
  {
    // The DEFAULT egress pipe: itx.fetch(...) and bare fetch() in every
    // platform-loaded isolate dispatch through THIS entry. The target is the
    // terminal, stateless EgressPipe (path: [], args: [request]): secret
    // placeholder substitution + the real fetch, no Durable Object in the
    // path. The dispatcher (ProjectEgress.fetch) routes chain-first and the
    // default is a DIFFERENT entrypoint — that is what breaks the loop.
    address: { entrypoint: "EgressPipe", type: "rpc", worker: { type: "loopback" } },
    instructions:
      "Project egress: itx.fetch(request) and bare fetch() inside platform-loaded " +
      "isolates both flow through this cap. Shadow it with your own `fetch` (e.g. a " +
      "bare function or live provider returning a Response) to intercept ALL egress " +
      "on your context while connected; revoke the shadow and this default " +
      "resurfaces. A shadow provider receives getSecret(...) placeholders " +
      "UNSUBSTITUTED — secret material only exists in the default pipe.",
    name: "fetch",
  },
  {
    address: { entrypoint: "StreamsCapability", type: "rpc", worker: { type: "loopback" } },
    instructions:
      "Event streams in this project's namespace: itx.streams.get('/path') returns a " +
      "stream handle with append/read/getState/subscribe; get also takes absolute " +
      "refs ('ns:/path') checked against this project's access. Chained calls ride " +
      "RPC promise pipelining.",
    name: "streams",
  },
  {
    // The project's secret store — the WRITE half of the placeholder design:
    // store material once (itx.secrets.setSecret), then reference it in any
    // egress header as getSecret({ key }) and the egress pipe substitutes it
    // server-side. The itx surface is writes + redacted summaries ONLY —
    // material never crosses an itx boundary (secrets-capability-call.ts).
    address: { entrypoint: "SecretsCapability", type: "rpc", worker: { type: "loopback" } },
    instructions:
      "Project secrets: itx.secrets.setSecret({ key, material }), listSecrets() " +
      "(redacted summaries), getSecretSummaryByKey({ key }), deleteSecret({ key }). " +
      'Reference a stored secret in any outbound-HTTP header as getSecret({ key: "…" }) ' +
      "— the platform substitutes the real value inside its own outbound-HTTP layer; " +
      "your code only ever sees the placeholder.",
    name: "secrets",
  },
  {
    // The project's third-party integrations (slack, google): the read +
    // connect/disconnect surface the dashboard settings use. OAuth material
    // itself never crosses itx — startOAuthFlow only returns a provider
    // authorization URL; tokens land in the secret store via the callback.
    address: { entrypoint: "IntegrationsCapability", type: "rpc", worker: { type: "loopback" } },
    instructions:
      "Project integrations (slack, google): itx.integrations.getConnection({ provider }) " +
      "returns connection status (connected, displayName, scopes, redacted token summary); " +
      "startOAuthFlow({ provider, callbackUrl?, userId }) returns { authorizationUrl } to begin " +
      "the provider OAuth flow (userId is the browser session's user — it only binds the OAuth " +
      "state; the callback's requireCallbackUser check is the real backstop); disconnect({ provider }) revokes the connection and " +
      "appends the disconnected event to the project's /integrations/<provider> stream.",
    name: "integrations",
  },
  {
    address: { entrypoint: "ReposCapability", type: "rpc", worker: { type: "loopback" } },
    instructions:
      "The project's git repos: itx.repos.ensureProjectRepoInfo({ projectSlug }), " +
      "list(), create({ slug }), get({ slug }) — repo handles expose commitFiles/readFiles/readLog.",
    name: "repos",
  },
  {
    // The project's agents. sendMessage FORCE-WAKES the agent Durable Object
    // (ensureStartedAndCaughtUp) before appending, so chat works even for a
    // cold or never-started/legacy agent — a raw stream append would not.
    address: { entrypoint: "AgentsCapability", type: "rpc", worker: { type: "loopback" } },
    instructions:
      "The project's agents: itx.agents.sendMessage({ agentPath, message, channel? }) wakes " +
      "the agent (cold/legacy included) and posts a user message, returning { event }; " +
      "list() returns the agent paths under /agents; listPresets() and " +
      "configurePreset({ basePath, model, provider, systemPrompt?, runOpts?, events? }) read " +
      "and write the agent-path-prefix presets.",
    name: "agents",
  },
  {
    // The workspace is provided EXPLICITLY (props.workspaceId) — workspaces
    // are not itx's concern: every context that wants its own workspace gets
    // one from its HOST (the agent provides its own on its context), and
    // everything else shares the project workspace through the chain.
    address: {
      entrypoint: "WorkspaceCapability",
      props: { workspaceId: "project" },
      type: "rpc",
      worker: { type: "loopback" },
    },
    instructions:
      "The project's shared workspace filesystem: itx.workspace.readFile/writeFile plus " +
      "the flat git methods gitClone/gitAdd/gitCommit/gitPush/gitStatus. Contexts whose " +
      "host provides its own `workspace` capability (agents) are isolated; plain " +
      "extensions share this one through the chain.",
    name: "workspace",
  },
  {
    // An ORDINARY repo source — the last project-worker specialness is gone.
    // The platform guarantees exactly one thing: every project has its
    // config repo with a defined file structure; this entry points at it.
    address: { type: "rpc", worker: { type: "source", source: PROJECT_WORKER_SOURCE } },
    instructions:
      "The project's own worker — the code in the project's repo " +
      "(worker.js), built per commit and tracking pushes: " +
      "itx.worker.someExportedFunction(args) reaches any public method of its default export.",
    name: "worker",
  },
];

export type PlatformContextProps = {
  /** The project whose chain ends here — injected by the host that wires the
   * parent link, never by capability providers. */
  projectId: string;
};

/**
 * The read-only context at the chain root. Answers the SAME context protocol
 * ({@link ItxStub}) as every node — describe/invoke from code, provide/revoke
 * refused — so chain delegation needs zero special cases.
 */
export class PlatformContext extends WorkerEntrypoint<Env, PlatformContextProps> {
  async describe(): Promise<CapabilityDescription[]> {
    // These are this context's OWN entries, so no `from` here — the project
    // core stamps `from: "defaults"` (DEFAULTS_DESCRIBE_FROM, types.ts) when
    // it merges them into a chain view (Itx.describe).
    return PLATFORM_PROJECT_CAPABILITIES.map((capability) => ({
      instructions: capability.instructions,
      kind: capability.address.type,
      meta: {},
      name: capability.name,
      updatedAtMs: 0,
    }));
  }

  async invoke(input: { path: string[]; args: unknown[]; origin?: ItxOrigin }): Promise<unknown> {
    const projectId = this.ctx.props.projectId;
    if (!projectId) throw new Error("PlatformContext needs host-injected projectId props.");
    const byName = Object.fromEntries(
      PLATFORM_PROJECT_CAPABILITIES.map((capability) => [capability.name, capability]),
    );
    const resolved = resolveLongestProvidedPrefix(byName, input.path);
    if (!resolved) {
      // This is the error every FULL-chain miss surfaces to the caller (the
      // chain root answers last), so it must read as "nothing anywhere",
      // not name internal plumbing like the platform:project chain id.
      throw new Error(
        `No capability named "${input.path[0] ?? ""}" on this context or anywhere up its chain` +
          (input.path.length > 1 ? ` (call path "${input.path.join(".")}").` : `.`) +
          ` describe() lists what exists.`,
      );
    }
    const origin = input.origin ?? {
      address: contextAddress(projectContextRef(projectId)),
      ref: projectContextRef(projectId),
    };
    const dial = makeDial({
      allowlists: resolveDialableTargets(parseConfig(this.env).itx),
      contextAddress: PLATFORM_PROJECT_CONTEXT_ADDRESS,
      contextRef: PLATFORM_PROJECT_CONTEXT_ID,
      env: this.env,
      exports: this.ctx.exports as unknown as Parameters<typeof makeDial>[0]["exports"],
      // The `worker` default is a repo SOURCE, so the chain's code root must
      // be able to load isolates (no facets: this entrypoint is stateless,
      // and no default is a durable-object source).
      loader: (this.env as { LOADER?: unknown }).LOADER as Parameters<typeof makeDial>[0]["loader"],
      projectId,
    });
    const borrowed = dial(resolved.entry.address, {
      capabilityPath: resolved.entry.name,
      origin,
    });
    try {
      return await borrowed.call({ args: input.args, path: resolved.remainder });
    } finally {
      (borrowed as Partial<Disposable>)[Symbol.dispose]?.();
    }
  }

  async provideCapability(_input: ProvideCapabilityInput): Promise<never> {
    throw new Error(
      "The defaults are read-only — they ship with the deploy. " +
        "Provide on your own context to shadow a default.",
    );
  }

  async revokeCapability(_input: { name?: string; path?: string[] }): Promise<never> {
    throw new Error(
      "The defaults are read-only — they ship with the deploy " +
        "and cannot be revoked; shadow them on your own context instead.",
    );
  }
}

/** The in-process parent link a project context's core delegates to: the
 * loopback dial of the defaults context, parameterized by project. */
export function getPlatformContext(input: {
  exports: Record<string, (options: { props: Record<string, unknown> }) => unknown>;
  projectId: string;
}): ItxStub {
  const factory = input.exports.PlatformContext;
  if (typeof factory !== "function") {
    throw new Error("PlatformContext loopback export is not available on this host.");
  }
  return factory({ props: { projectId: input.projectId } }) as ItxStub;
}
