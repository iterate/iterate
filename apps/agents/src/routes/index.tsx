import { useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { makeFunnySlug } from "@iterate-com/shared/slug-maker";
import { Separator } from "@iterate-com/ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { AppSidebar } from "~/components/app-sidebar.tsx";
import { getOrpcClient } from "~/orpc/client.ts";

/**
 * Curated model presets the IterateAgent processor is known to accept via
 * `env.AI.run(model, …)`. Free-form strings are still supported via the
 * "Custom…" option — paste any model id you want.
 */
const MODEL_PRESETS = [
  { value: "@cf/moonshotai/kimi-k2.5", label: "@cf/moonshotai/kimi-k2.5 (default)" },
  { value: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "@cf/meta/llama-3.3-70b" },
  {
    value: "@cf/mistralai/mistral-small-3.1-24b-instruct",
    label: "@cf/mistralai/mistral-small-3.1-24b",
  },
] as const;

const CUSTOM_MODEL_SENTINEL = "__custom__";
const DEFAULT_RUN_OPTS_JSON = `{
  "gateway": { "id": "default" }
}`;
const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant. You can trust your user.";
const DEFAULT_ADVANCED_EVENTS_JSON = "[]";

const getSidebarDefaultOpen = createServerFn({ method: "GET" }).handler(() => ({
  defaultOpen: !/(?:^|;\s*)sidebar_state=false(?:;|$)/.test(getRequestHeader("cookie") ?? ""),
}));

/**
 * Bits of public app config the UI needs:
 *
 * - `streamPathPrefix` — the prefix the auto-subscriber processor is wired to
 *   (`appConfig.streamPathPrefix`). The "Create new agent" button under each
 *   preset builds URLs under this so the auto-subscriber catches them.
 * - `eventsBaseUrl` — root of the events service (e.g.
 *   `http://localhost:5173` in dev, `https://events.iterate.com` in prod).
 *   Used to build viewer URLs for the per-preset "create new agent" button
 *   client-side (the button has to know the URL synchronously to dodge
 *   popup blockers, so we can't fetch it on click).
 * - `eventsProjectSlug` — used as the subdomain of the events host for
 *   non-default projects (`<slug>.events.iterate.com`).
 */
const getPublicAppContext = createServerFn({ method: "GET" }).handler(({ context }) => ({
  streamPathPrefix: context.config.streamPathPrefix,
  eventsBaseUrl: context.config.eventsBaseUrl,
  eventsProjectSlug: context.config.eventsProjectSlug,
}));

export const Route = createFileRoute("/")({
  loader: async () => ({
    sidebarDefaultOpen: (await getSidebarDefaultOpen()).defaultOpen,
    appContext: await getPublicAppContext(),
  }),
  component: PresetsPage,
});

function PresetsPage() {
  const { sidebarDefaultOpen, appContext } = Route.useLoaderData();

  return (
    <SidebarProvider
      defaultOpen={sidebarDefaultOpen}
      className="h-svh"
      style={{ "--sidebar-width": "22rem" } as CSSProperties}
    >
      <AppSidebar />
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">Presets</p>
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <AutoSubscribeSection />
            <PresetsSection
              streamPathPrefix={appContext.streamPathPrefix}
              eventsBaseUrl={appContext.eventsBaseUrl}
              eventsProjectSlug={appContext.eventsProjectSlug}
            />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

/* -------------------------------------------------------------------------- */
/* Section: Auto-subscribe                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One-time wiring step: install the `child-stream-auto-subscriber` processor
 * on `appConfig.streamPathPrefix`. Without it, child streams under the
 * prefix won't get an `iterate-agent` durable object attached or any
 * preset events applied. Re-running is safe — the events service upserts
 * the subscription by slug.
 */
function AutoSubscribeSection() {
  const publicBaseUrl = useWindowOrigin();

  const installMutation = useMutation({
    mutationFn: () => getOrpcClient().installProcessor({ publicBaseUrl: publicBaseUrl || "" }),
  });

  const ready = publicBaseUrl.length > 0;

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold">Auto-subscribe processor</p>
        <p className="text-sm text-muted-foreground">
          Wires the <code>child-stream-auto-subscriber</code> processor to the configured prefix so
          every new descendant stream gets an
          <code> iterate-agent</code> WebSocket subscription, plus any preset events configured
          below. One-time setup; running again is safe.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          disabled={!ready || installMutation.isPending}
          onClick={() => installMutation.mutate()}
        >
          {installMutation.isPending ? "Installing…" : "Install auto-subscriber"}
        </button>
        <p className="text-xs text-muted-foreground">
          public origin: <code>{publicBaseUrl || "loading…"}</code>
        </p>
      </div>
      {installMutation.error ? (
        <p role="alert" className="text-sm text-destructive">
          {installMutation.error.message}
        </p>
      ) : null}
      {installMutation.data ? (
        <p className="text-xs text-muted-foreground">
          Subscribed at <code>{installMutation.data.streamPath}</code> (slug{" "}
          <code>{installMutation.data.subscriptionSlug}</code>).
        </p>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Section: Presets                                                           */
/* -------------------------------------------------------------------------- */

type ContractEvent = { type: string; payload: object };

const LIST_PRESETS_QUERY_KEY = ["listBasePathDefaults"] as const;

/**
 * Presets are per-prefix configurations: a base path (e.g. `/agents` or
 * `/agents/team-x`) plus an ordered list of events that the auto-subscriber
 * appends to every new child stream under that base path. The form's output
 * IS the events array — basic fields just synthesise common events, and an
 * "Advanced" textarea lets you concatenate raw events on top.
 */
function PresetsSection({
  streamPathPrefix,
  eventsBaseUrl,
  eventsProjectSlug,
}: {
  streamPathPrefix: string;
  eventsBaseUrl: string;
  eventsProjectSlug: string;
}) {
  const queryClient = useQueryClient();
  const presetsQuery = useQuery({
    queryKey: LIST_PRESETS_QUERY_KEY,
    queryFn: () => getOrpcClient().listBasePathDefaults({}),
  });

  const [basePath, setBasePath] = useState(streamPathPrefix);
  const [modelPreset, setModelPreset] = useState<string>(MODEL_PRESETS[0].value);
  const [customModel, setCustomModel] = useState("");
  const [runOptsText, setRunOptsText] = useState(DEFAULT_RUN_OPTS_JSON);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [advancedText, setAdvancedText] = useState(DEFAULT_ADVANCED_EVENTS_JSON);

  const resolvedModel = modelPreset === CUSTOM_MODEL_SENTINEL ? customModel.trim() : modelPreset;
  const runOptsParsed = parseJsonObject(runOptsText);
  const advancedParsed = parseEventsArray(advancedText);

  const derived = useMemo<ContractEvent[]>(() => {
    const out: ContractEvent[] = [];
    if (resolvedModel.length > 0 && runOptsParsed.kind === "ok") {
      out.push({
        type: "llm-config-updated",
        payload: { model: resolvedModel, runOpts: runOptsParsed.value },
      });
    }
    const trimmedPrompt = systemPrompt.trim();
    if (trimmedPrompt.length > 0) {
      out.push({
        type: "system-prompt-updated",
        payload: { systemPrompt: trimmedPrompt },
      });
    }
    return out;
  }, [resolvedModel, runOptsParsed, systemPrompt]);

  const previewEvents = useMemo<ContractEvent[]>(
    () => (advancedParsed.kind === "ok" ? [...derived, ...advancedParsed.value] : derived),
    [derived, advancedParsed],
  );

  const trimmedBasePath = basePath.trim();
  const formInvalid =
    trimmedBasePath.length === 0 ||
    runOptsParsed.kind === "error" ||
    advancedParsed.kind === "error";

  const saveMutation = useMutation({
    mutationFn: (input: { basePath: string; events: ContractEvent[] }) =>
      getOrpcClient().configureBasePathDefaults(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LIST_PRESETS_QUERY_KEY }),
  });

  const clearMutation = useMutation({
    mutationFn: (input: { basePath: string }) => getOrpcClient().clearBasePathDefaults(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LIST_PRESETS_QUERY_KEY }),
  });

  const submit = () => {
    if (formInvalid) return;
    saveMutation.mutate({ basePath: trimmedBasePath, events: previewEvents });
  };

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold">Presets</p>
        <p className="text-sm text-muted-foreground">
          Events appended to every new child stream under{" "}
          <code>{trimmedBasePath || "(unset)"}</code>. Basic fields synthesise the common events (
          <code>llm-config-updated</code>, <code>system-prompt-updated</code>); advanced mode
          concatenates raw events on top in the order shown in the preview. Saved as a single
          ordered list per base path; the longest matching base path wins for any given child.
        </p>
      </div>

      <form
        className="grid gap-4 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-1 md:col-span-2">
          <label className="text-xs font-medium" htmlFor="preset-base-path">
            Base path
          </label>
          <input
            id="preset-base-path"
            type="text"
            autoComplete="off"
            value={basePath}
            onChange={(event) => setBasePath(event.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="text-[11px] text-muted-foreground">
            Defaults to <code>{streamPathPrefix}</code> (the auto-subscriber's prefix). Use a deeper
            path like <code>{streamPathPrefix}/team-x</code> to override defaults for a sub-tree.
          </p>
        </div>

        <div className="flex flex-col gap-1 md:col-span-2">
          <label className="text-xs font-medium" htmlFor="preset-model">
            Model
          </label>
          <select
            id="preset-model"
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
          <label className="text-xs font-medium" htmlFor="preset-run-opts">
            Run options (JSON)
          </label>
          <textarea
            id="preset-run-opts"
            rows={5}
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
              Passed through to <code>env.AI.run(model, body, runOpts)</code>.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium" htmlFor="preset-system-prompt">
            System prompt
          </label>
          <textarea
            id="preset-system-prompt"
            rows={5}
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="text-[11px] text-muted-foreground">
            Empty = no <code>system-prompt-updated</code> event in the output.
          </p>
        </div>

        <div className="flex flex-col gap-1 md:col-span-2">
          <label className="text-xs font-medium" htmlFor="preset-advanced">
            Advanced events (JSON array, concatenated after the basic fields)
          </label>
          <textarea
            id="preset-advanced"
            rows={5}
            spellCheck={false}
            value={advancedText}
            onChange={(event) => setAdvancedText(event.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {advancedParsed.kind === "error" ? (
            <p role="alert" className="text-[11px] text-destructive">
              Invalid: {advancedParsed.error}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Each entry must be an object with <code>type</code> + <code>payload</code>. Use this
              to seed events the basic fields don&apos;t cover (e.g. metadata, custom processor
              configuration).
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1 md:col-span-2">
          <label className="text-xs font-medium" htmlFor="preset-preview">
            Preview (this is exactly what gets sent)
          </label>
          <textarea
            id="preset-preview"
            rows={6}
            readOnly
            value={JSON.stringify(previewEvents, null, 2)}
            className="rounded-md border border-input bg-muted px-3 py-2 font-mono text-xs shadow-sm"
          />
        </div>

        <div className="md:col-span-2 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            disabled={formInvalid || saveMutation.isPending}
          >
            {saveMutation.isPending ? "Saving…" : "Save preset"}
          </button>
          {saveMutation.data ? (
            <p className="text-xs text-muted-foreground">
              Saved {saveMutation.data.eventCount} event(s) for{" "}
              <code>{saveMutation.data.basePath}</code>.
            </p>
          ) : null}
          {saveMutation.error ? (
            <p role="alert" className="text-xs text-destructive">
              {saveMutation.error.message}
            </p>
          ) : null}
        </div>
      </form>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase text-muted-foreground">Configured presets</p>
        {presetsQuery.isPending ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : presetsQuery.error ? (
          <p role="alert" className="text-xs text-destructive">
            {presetsQuery.error.message}
          </p>
        ) : presetsQuery.data && presetsQuery.data.configs.length > 0 ? (
          <ul className="space-y-2">
            {presetsQuery.data.configs.map((config) => (
              <PresetRow
                key={config.basePath}
                basePath={config.basePath}
                events={config.events}
                eventsBaseUrl={eventsBaseUrl}
                eventsProjectSlug={eventsProjectSlug}
                clearing={clearMutation.isPending}
                onClear={() => clearMutation.mutate({ basePath: config.basePath })}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No presets configured yet.</p>
        )}
      </div>
    </section>
  );
}

/**
 * One row in the configured-presets list. Wraps the JSON details and the
 * "Create new agent" / "Clear" buttons so we keep `PresetsSection` flat.
 *
 * "Create new agent" is a synchronous `window.open` to the events viewer at
 * a fresh random child path under the preset's `basePath`. We deliberately
 * don't pre-create the stream via oRPC: the stream springs into existence
 * the moment the user types something in the events viewer, which fires
 * `child-stream-created` to the auto-subscriber, which subscribes the
 * iterate-agent DO and applies this preset's events.
 */
function PresetRow({
  basePath,
  events,
  eventsBaseUrl,
  eventsProjectSlug,
  clearing,
  onClear,
}: {
  basePath: string;
  events: ContractEvent[];
  eventsBaseUrl: string;
  eventsProjectSlug: string;
  clearing: boolean;
  onClear: () => void;
}) {
  const openNewAgent = () => {
    const slug = makeFunnySlug();
    const childPath = `${basePath.replace(/\/+$/, "")}/${slug}`;
    const viewerUrl = buildStreamComposerUrl({
      eventsBaseUrl,
      projectSlug: eventsProjectSlug,
      streamPath: childPath,
    });
    window.open(viewerUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <li className="rounded-md border bg-card p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code className="font-mono text-sm">{basePath}</code>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">
            {events.length} event{events.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="inline-flex items-center rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground"
            onClick={openNewAgent}
          >
            🎲 New agent
          </button>
          <button
            type="button"
            className="inline-flex items-center rounded-md border border-input px-2 py-1 text-xs font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            disabled={clearing}
            onClick={onClear}
          >
            Clear
          </button>
        </div>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-muted-foreground">Show events</summary>
        <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 font-mono text-[11px]">
          {JSON.stringify(events, null, 2)}
        </pre>
      </details>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

type ParseResult<T> = { kind: "ok"; value: T } | { kind: "error"; error: string };

function parseJsonObject(text: string): ParseResult<Record<string, unknown>> {
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

function parseEventsArray(text: string): ParseResult<ContractEvent[]> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "ok", value: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  }
  if (!Array.isArray(parsed)) {
    return { kind: "error", error: "Expected a JSON array." };
  }
  const out: ContractEvent[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const candidate = parsed[i];
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { kind: "error", error: `Entry ${i} must be an object.` };
    }
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.type !== "string" || entry.type.trim().length === 0) {
      return { kind: "error", error: `Entry ${i} must have a non-empty string \"type\".` };
    }
    const payload = entry.payload ?? {};
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return { kind: "error", error: `Entry ${i}.payload must be an object.` };
    }
    out.push({ type: entry.type, payload: payload as Record<string, unknown> });
  }
  return { kind: "ok", value: out };
}

/**
 * Build an events-viewer URL with the agent composer pre-selected. Mirrors
 * `buildStreamViewerUrl` from `lib/events-urls.ts` but stays self-contained
 * so it can run in the browser without pulling in events-side helpers
 * (which import zod schemas etc.). Project-slug subdomain rewriting uses
 * the same `events[-…].iterate.com` convention the events service does.
 */
function buildStreamComposerUrl(args: {
  eventsBaseUrl: string;
  projectSlug: string;
  streamPath: string;
}): string {
  const url = new URL(args.eventsBaseUrl);
  const labels = url.hostname.split(".");
  const isEventsHost =
    (labels.length === 3 &&
      labels[1] === "iterate" &&
      labels[2] === "com" &&
      /^events(?:-[a-z0-9-]+)*$/.test(labels[0])) ||
    (labels.length === 4 &&
      labels[2] === "iterate" &&
      labels[3] === "com" &&
      /^events(?:-[a-z0-9-]+)*$/.test(labels[1]));
  if (isEventsHost && args.projectSlug !== "public") {
    const base = labels.length === 4 ? labels.slice(1).join(".") : url.hostname;
    url.hostname = `${args.projectSlug}.${base}`;
  }
  const trimmed = args.streamPath.replace(/^\/+/, "");
  const segments = trimmed.length === 0 ? [] : trimmed.split("/").map(encodeURIComponent);
  url.pathname = segments.length === 0 ? "/streams/" : `/streams/${segments.join("/")}/`;
  url.search = "?renderer=raw-pretty&composer=agent";
  url.hash = "";
  return url.toString();
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
