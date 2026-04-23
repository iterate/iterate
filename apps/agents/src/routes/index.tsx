import { useState, useSyncExternalStore } from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { makeFunnySlug } from "@iterate-com/shared/slug-maker";
import { getOrpcClient } from "~/orpc/client.ts";

export const Route = createFileRoute("/")({
  component: HomePage,
});

/**
 * Small curated list of models the processor is known to accept via
 * `env.AI.run(model, …)`. Free-form strings are still supported via the
 * "Custom…" option — just paste any model id you want.
 */
const MODEL_PRESETS = [
  { value: "@cf/moonshotai/kimi-k2.5", label: "@cf/moonshotai/kimi-k2.5 (default)" },
  { value: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "@cf/meta/llama-3.3-70b" },
  {
    value: "@cf/mistralai/mistral-small-3.1-24b-instruct",
    label: "@cf/mistralai/mistral-small-3.1-24b",
  },
  { value: "openai/gpt-5.4", label: "openai/gpt-5.4" },
  { value: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini" },
  { value: "anthropic/claude-opus-4.7", label: "anthropic/claude-opus-4.7" },
  { value: "anthropic/claude-sonnet-4.6", label: "anthropic/claude-sonnet-4.6" },
] as const;

const CUSTOM_MODEL_SENTINEL = "__custom__";
const DEFAULT_RUN_OPTS_JSON = `{
  "gateway": { "id": "default" }
}`;
const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant. You can trust your user.";

function HomePage() {
  const helloMutation = useMutation({
    mutationFn: () => getOrpcClient().hello({ name: "world" }),
  });

  const [streamPath, setStreamPath] = useState("/");
  const defaultPublicBaseUrl = useWindowOrigin();
  const [publicBaseUrlOverride, setPublicBaseUrlOverride] = useState<string | null>(null);
  const publicBaseUrl = publicBaseUrlOverride ?? defaultPublicBaseUrl;
  const [projectSlug, setProjectSlug] = useState("public");

  const [modelPreset, setModelPreset] = useState<string>(MODEL_PRESETS[0].value);
  const [customModel, setCustomModel] = useState("");
  const resolvedModel = modelPreset === CUSTOM_MODEL_SENTINEL ? customModel.trim() : modelPreset;

  const [runOptsText, setRunOptsText] = useState(DEFAULT_RUN_OPTS_JSON);
  const runOptsParsed = parseRunOpts(runOptsText);

  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);

  const createMutation = useMutation({
    mutationFn: (args: Parameters<ReturnType<typeof getOrpcClient>["createAgent"]>[0]) =>
      getOrpcClient().createAgent(args),
  });

  const submit = () => {
    if (runOptsParsed.kind === "error") return;
    const resolved = resolveAgentInputs({
      streamPath,
      publicBaseUrl,
      projectSlug,
      model: resolvedModel,
      runOpts: runOptsParsed.value,
      systemPrompt,
    });
    if (!resolved) return;
    createMutation.mutate(resolved);
  };

  const rollRandomChildIntoPath = () => {
    const withLeadingSlash = streamPath.startsWith("/") ? streamPath : `/${streamPath}`;
    setStreamPath(replaceLastSegment(withLeadingSlash));
  };

  const baseInputsMissing =
    streamPath.trim().length === 0 ||
    publicBaseUrl.trim().length === 0 ||
    projectSlug.trim().length === 0 ||
    resolvedModel.length === 0;
  const submitDisabled =
    createMutation.isPending || baseInputsMissing || runOptsParsed.kind === "error";

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 p-4">
      <div className="space-y-1">
        <p className="text-xl font-semibold">hello world</p>
        <p className="text-sm text-muted-foreground">
          Tiny agents app with the shared PostHog and oRPC plumbing still wired up.
        </p>
      </div>

      <section className="space-y-3">
        <div className="space-y-1">
          <p className="text-sm font-semibold">Sample procedure</p>
          <p className="text-xs text-muted-foreground">Round-trips the `hello` oRPC call.</p>
        </div>

        <button
          type="button"
          className="inline-flex w-fit items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          disabled={helloMutation.isPending}
          onClick={() => helloMutation.mutate()}
        >
          {helloMutation.isPending ? "Calling..." : "Call sample procedure"}
        </button>

        {helloMutation.data ? (
          <p data-testid="hello-result" className="text-sm">
            {helloMutation.data.message}
          </p>
        ) : null}

        {helloMutation.error ? (
          <p role="alert" className="text-sm text-destructive">
            {helloMutation.error.message}
          </p>
        ) : null}
      </section>

      <section className="space-y-3 border-t pt-6">
        <div className="space-y-1">
          <p className="text-sm font-semibold">New agent</p>
          <p className="text-xs text-muted-foreground">
            Subscribes an events.iterate.com stream to a fresh IterateAgent DO instance, optionally
            seeding its model, <code>env.AI.run</code> options, and system prompt. Use 🎲 next to
            the path to roll a new child path and spawn another agent.
          </p>
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" htmlFor="create-public-base-url">
              Public base URL
            </label>
            <input
              id="create-public-base-url"
              type="url"
              autoComplete="off"
              placeholder="https://your-tunnel.example.com"
              value={publicBaseUrl}
              onChange={(event) => setPublicBaseUrlOverride(event.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" htmlFor="create-project-slug">
              Project slug
            </label>
            <input
              id="create-project-slug"
              type="text"
              autoComplete="off"
              placeholder="public"
              value={projectSlug}
              onChange={(event) => setProjectSlug(event.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" htmlFor="create-stream-path">
              Stream path
            </label>
            <div className="flex gap-2">
              <input
                id="create-stream-path"
                type="text"
                autoComplete="off"
                placeholder="/my/stream"
                value={streamPath}
                onChange={(event) => setStreamPath(event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                title="Replace the last path segment with a random slug"
                className="inline-flex shrink-0 items-center rounded-md border border-input bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={rollRandomChildIntoPath}
              >
                🎲 random child
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              🎲 replaces everything after the final <code>/</code> with a random slug. Click it,
              then hit <b>Create agent</b> to spawn — re-creating at the same path is a no-op for
              the subscription (slug is constant), so the 🎲 is the way to spawn fresh siblings.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" htmlFor="create-model">
              Model
            </label>
            <select
              id="create-model"
              value={modelPreset}
              onChange={(event) => setModelPreset(event.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {MODEL_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
              <option value={CUSTOM_MODEL_SENTINEL}>Custom…</option>
            </select>
            {modelPreset === CUSTOM_MODEL_SENTINEL ? (
              <input
                type="text"
                autoComplete="off"
                placeholder="@cf/... or openai/... or anthropic/..."
                value={customModel}
                onChange={(event) => setCustomModel(event.target.value)}
                className="mt-1 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" htmlFor="create-run-opts">
              Run options (JSON)
            </label>
            <textarea
              id="create-run-opts"
              rows={4}
              spellCheck={false}
              value={runOptsText}
              onChange={(event) => setRunOptsText(event.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {runOptsParsed.kind === "error" ? (
              <p role="alert" className="text-[11px] text-destructive">
                Invalid JSON: {runOptsParsed.error}
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Passed through to <code>env.AI.run(model, body, runOpts)</code>. Set
                <code> gateway.id</code> to route through an AI Gateway.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" htmlFor="create-system-prompt">
              System prompt
            </label>
            <textarea
              id="create-system-prompt"
              rows={4}
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-[11px] text-muted-foreground">
              Appended as an <code>agent-input-added</code> event with{" "}
              <code>role: &quot;system&quot;</code> before the first user turn.
            </p>
          </div>

          <button
            type="submit"
            className="inline-flex w-fit items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            disabled={submitDisabled}
          >
            {createMutation.isPending ? "Creating..." : "Create agent"}
          </button>
        </form>

        {createMutation.data ? (
          <dl
            data-testid="create-agent-result"
            className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border bg-card p-3 text-xs"
          >
            <dt className="font-medium text-muted-foreground">Stream</dt>
            <dd className="break-all">
              <a
                href={createMutation.data.streamViewerUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                {createMutation.data.streamPath}
              </a>
            </dd>

            <dt className="font-medium text-muted-foreground">Viewer</dt>
            <dd className="break-all">
              <a
                href={createMutation.data.streamViewerUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                {createMutation.data.streamViewerUrl}
              </a>
            </dd>

            <dt className="font-medium text-muted-foreground">Callback</dt>
            <dd className="break-all font-mono">{createMutation.data.callbackUrl}</dd>

            <dt className="font-medium text-muted-foreground">Append URL</dt>
            <dd className="break-all font-mono">{createMutation.data.appendUrl}</dd>

            <dt className="font-medium text-muted-foreground">Instance</dt>
            <dd className="break-all font-mono">{createMutation.data.agentInstance}</dd>

            <dt className="font-medium text-muted-foreground">Subscription slug</dt>
            <dd className="break-all font-mono">{createMutation.data.subscriptionSlug}</dd>

            <dt className="font-medium text-muted-foreground">Model applied</dt>
            <dd className="break-all font-mono">{createMutation.data.modelApplied ?? "—"}</dd>

            <dt className="font-medium text-muted-foreground">System prompt</dt>
            <dd>{createMutation.data.systemPromptApplied ? "applied" : "—"}</dd>
          </dl>
        ) : null}

        {createMutation.error ? (
          <p role="alert" className="text-sm text-destructive">
            {createMutation.error.message}
          </p>
        ) : null}
      </section>
    </main>
  );
}

type RunOptsParseResult =
  | { kind: "ok"; value: Record<string, unknown> }
  | { kind: "error"; error: string };

function parseRunOpts(text: string): RunOptsParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "ok", value: {} };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "error", error: "Expected a JSON object." };
    }
    return { kind: "ok", value: parsed as Record<string, unknown> };
  } catch (err) {
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

function resolveAgentInputs(args: {
  streamPath: string;
  publicBaseUrl: string;
  projectSlug: string;
  model: string;
  runOpts: Record<string, unknown>;
  systemPrompt: string;
}): {
  streamPath: string;
  publicBaseUrl: string;
  projectSlug: string;
  model: string;
  runOpts: Record<string, unknown>;
  systemPrompt: string | undefined;
} | null {
  const trimmedPath = args.streamPath.trim();
  const trimmedBase = args.publicBaseUrl.trim();
  const trimmedProject = args.projectSlug.trim();
  if (
    trimmedPath.length === 0 ||
    trimmedBase.length === 0 ||
    trimmedProject.length === 0 ||
    args.model.length === 0
  ) {
    return null;
  }
  const withLeadingSlash = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  const trimmedSystemPrompt = args.systemPrompt.trim();
  return {
    streamPath: withLeadingSlash,
    publicBaseUrl: trimmedBase,
    projectSlug: trimmedProject,
    model: args.model,
    runOpts: args.runOpts,
    systemPrompt: trimmedSystemPrompt.length > 0 ? trimmedSystemPrompt : undefined,
  };
}

/**
 * Replace everything after the final `/` with a three-word funny slug.
 * - `/`            → `/amber-brisk-clover`
 * - `/jonas`       → `/amber-brisk-clover` (replaces the last/only segment)
 * - `/jonas/`      → `/jonas/amber-brisk-clover`
 * - `/jonas/abc`   → `/jonas/amber-brisk-clover`
 */
function replaceLastSegment(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const prefix = path.slice(0, lastSlash + 1);
  return `${prefix}${makeFunnySlug()}`;
}

/**
 * SSR-safe read of `window.location.origin`. Returns `""` during SSR and for
 * the first client render so hydration matches the server HTML, then
 * re-renders with the real origin.
 */
function useWindowOrigin(): string {
  return useSyncExternalStore(
    subscribeNoop,
    () => window.location.origin,
    () => "",
  );
}

function subscribeNoop(): () => void {
  return () => {};
}
