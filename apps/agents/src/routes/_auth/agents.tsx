import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import type { AuthenticatedApp } from "iterate/next/app";
import { useLiveState } from "iterate/next/react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";

// An agent is a conversation on its own path (`/agents/<name>`); everything it does is an event
// there. This page is a window onto that log: the feed is DERIVED from the events (a person's words,
// the assistant's prose, the scripts it ran and what they returned), the strip above the composer is
// the agent facet's LIVE STATE (thinking / running a script / paused / idle), and the composer is
// `itx.agents.get(path).message(...)`. The project stub is held for the page's life; the agent's
// context is `project.cd(path)`, subscribed for pushes and caught up with `readEvents`.
type Project = Awaited<ReturnType<AuthenticatedApp["api"]["projects"]["get"]>>;
type Context = Awaited<ReturnType<Project["cd"]>>;

const AgentList = z.array(z.object({ path: z.string(), createdAt: z.string() }));
const FileAttachment = z.object({
  contentType: z.string(),
  filename: z.string(),
  path: z.string(),
  size: z.number(),
});
/** The events the feed renders; anything else on the path is skipped. */
const FeedEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("events.iterate.com/agents/context-added"),
    payload: z.object({
      role: z.string(),
      content: z.string(),
      actor: z.object({ email: z.string().optional() }).optional(),
      files: z.array(FileAttachment).optional(),
    }),
  }),
  z.object({
    type: z.literal("events.iterate.com/agents/web-message-sent"),
    payload: z.object({ message: z.string() }),
  }),
  z.object({
    type: z.literal("events.iterate.com/agent/summary-updated"),
    payload: z.object({ activity: z.string() }),
  }),
  z.object({
    type: z.literal("events.iterate.com/agent/llm-request-settled"),
    payload: z.object({
      result: z.discriminatedUnion("status", [
        z.object({ status: z.literal("succeeded") }),
        z.object({ status: z.literal("failed"), errorMessage: z.string() }),
        z.object({ status: z.literal("cancelled") }),
      ]),
    }),
  }),
  z.object({
    type: z.literal("events.iterate.com/agent/paused"),
    payload: z.object({ reason: z.string() }),
  }),
  z.object({ type: z.literal("events.iterate.com/agent/resumed"), payload: z.object({}) }),
  z.object({
    type: z.literal("events.iterate.com/capability-host/script-run-requested"),
    payload: z.object({ code: z.string(), executionId: z.string() }),
  }),
  z.object({
    type: z.literal("events.iterate.com/capability-host/script-run-settled"),
    payload: z.object({
      executionId: z.string(),
      settlement: z.discriminatedUnion("status", [
        z.object({ status: z.literal("succeeded"), result: z.unknown().optional() }),
        z.object({ status: z.literal("failed"), error: z.string() }),
      ]),
    }),
  }),
]);
const FEED_TYPES = FeedEvent.options.map((option) => option.shape.type.value);
const StreamRow = z.object({ offset: z.number(), createdAt: z.string() });
type FeedEvent = z.infer<typeof FeedEvent> & z.infer<typeof StreamRow>;

export const Route = createFileRoute("/_auth/agents")({
  validateSearch: z.object({ project: z.string().optional(), agent: z.string().optional() }),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    const projects = await context.api.projects.list();
    const project = deps.project ? projects.find((item) => item.id === deps.project) : projects[0];
    if (deps.project && !project) throw new Error("This session cannot access that project.");
    let agents: z.infer<typeof AgentList> = [];
    if (project) {
      using itx = await context.api.projects.get(project.id);
      agents = AgentList.parse(await itx.invoke(["itx", "agents", ["list"]]));
    }
    const agent = deps.agent || agents[0]?.path;
    return { projects, project, agents, agent };
  },
  component: AgentsPage,
});

function AgentsPage() {
  const data = Route.useLoaderData();
  const { api, info } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  async function createAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data.project) return;
    const element = event.currentTarget;
    const form = new FormData(element);
    const path = `/agents/${String(form.get("name")).trim()}`;
    const systemPrompt = String(form.get("prompt")).trim();
    setError(null);
    try {
      using itx = await api.projects.get(data.project.id);
      await itx.invoke([
        "itx",
        "agents",
        ["get", path],
        ["create", systemPrompt ? { systemPrompt } : {}],
      ]);
      element.reset();
      await router.invalidate();
      await navigate({ to: "/agents", search: { project: data.project.id, agent: path } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">AGENTS</p>
          <h1>{data.agent ? data.agent.replace(/^\/agents\//, "") : "Your agents"}</h1>
        </div>
        <form method="post" action="/.auth/logout">
          <button type="submit">Log out</button>
        </form>
      </header>
      <p className="muted">
        {info.principal.email || info.principal.actor}
        {data.projects.length > 1 && " · "}
        {data.projects.length > 1 &&
          data.projects.map((project) => (
            <span key={project.id}>
              <Link to="/agents" search={{ project: project.id }}>
                {project.id}
              </Link>{" "}
            </span>
          ))}
        {" · "}
        <Link to="/dashboard">Project dashboard</Link>
      </p>
      {data.project ? (
        <>
          <nav className="agents" aria-label="Agents">
            {data.agents.map((agent) => (
              <Link
                key={agent.path}
                to="/agents"
                search={{ project: data.project!.id, agent: agent.path }}
                aria-current={agent.path === data.agent ? "page" : undefined}
              >
                {agent.path.replace(/^\/agents\//, "")}
              </Link>
            ))}
          </nav>
          <form className="new-agent" onSubmit={createAgent}>
            <input
              name="name"
              placeholder="new agent name, e.g. support"
              pattern="[a-z0-9\-]+"
              required
            />
            <input name="prompt" placeholder="system prompt (optional)" />
            <button className="quiet" type="submit">
              Create
            </button>
          </form>
          {error && <p id="error">{error}</p>}
          {data.agent && (
            <Conversation
              key={`${data.project.id}${data.agent}`}
              project={data.project.id}
              path={data.agent}
            />
          )}
        </>
      ) : (
        <p>
          No projects yet. <Link to="/dashboard">Create a project</Link>.
        </p>
      )}
    </main>
  );
}

// ── the conversation ── one agent's log, live.

type Row =
  | { kind: "prompt"; offset: number; text: string }
  | {
      kind: "user";
      offset: number;
      at: string;
      text: string;
      who?: string;
      files: z.infer<typeof FileAttachment>[];
    }
  | { kind: "assistant"; offset: number; markdown: string; raw?: true }
  | {
      kind: "script";
      offset: number;
      label?: string;
      code: string;
      settlement?: { status: "succeeded"; result?: unknown } | { status: "failed"; error: string };
    }
  | { kind: "note"; offset: number; text: string; amber?: true };

/** The feed as the log tells it, in offset order. A raw assistant item is shown only when nothing
 *  was derived from it (no prose, no script) — otherwise the derived rows ARE the answer. */
function deriveFeed(events: FeedEvent[]): { rows: Row[]; activity?: string } {
  const rows: Row[] = [];
  const scripts = new Map<string, Extract<Row, { kind: "script" }>>();
  let raw: Extract<Row, { kind: "assistant" }> | undefined;
  let activity: string | undefined;
  let afterSettlement = false;
  for (const event of events) {
    const wasAfterSettlement = afterSettlement;
    afterSettlement = false;
    switch (event.type) {
      case "events.iterate.com/agents/context-added": {
        const { role, content } = event.payload;
        if (role === "system") rows.push({ kind: "prompt", offset: event.offset, text: content });
        else if (role === "user")
          rows.push({
            kind: "user",
            offset: event.offset,
            at: event.createdAt,
            text: content,
            who: event.payload.actor?.email,
            files: event.payload.files || [],
          });
        else if (role === "assistant") {
          raw = { kind: "assistant", offset: event.offset, markdown: content, raw: true };
          rows.push(raw);
        } else if (role === "developer" && !wasAfterSettlement)
          rows.push({ kind: "note", offset: event.offset, text: content, amber: true });
        break;
      }
      case "events.iterate.com/agents/web-message-sent":
        if (raw) raw.markdown = "";
        rows.push({ kind: "assistant", offset: event.offset, markdown: event.payload.message });
        break;
      case "events.iterate.com/agent/summary-updated":
        activity = event.payload.activity;
        break;
      case "events.iterate.com/capability-host/script-run-requested": {
        if (raw) raw.markdown = "";
        const row: Extract<Row, { kind: "script" }> = {
          kind: "script",
          offset: event.offset,
          label: activity,
          code: event.payload.code,
        };
        scripts.set(event.payload.executionId, row);
        rows.push(row);
        break;
      }
      case "events.iterate.com/capability-host/script-run-settled": {
        const row = scripts.get(event.payload.executionId);
        if (row) row.settlement = event.payload.settlement;
        afterSettlement = true;
        break;
      }
      case "events.iterate.com/agent/paused":
        rows.push({
          kind: "note",
          offset: event.offset,
          text: `Paused — ${event.payload.reason}`,
          amber: true,
        });
        break;
      case "events.iterate.com/agent/resumed":
        rows.push({ kind: "note", offset: event.offset, text: "Resumed" });
        break;
      case "events.iterate.com/agent/llm-request-settled":
        if (event.payload.result.status === "failed")
          rows.push({
            kind: "note",
            offset: event.offset,
            text: `Model call failed — ${event.payload.result.errorMessage}`,
            amber: true,
          });
        else if (event.payload.result.status === "cancelled")
          rows.push({
            kind: "note",
            offset: event.offset,
            text: "Model call expired",
            amber: true,
          });
        break;
    }
  }
  return { rows: rows.filter((row) => row.kind !== "assistant" || row.markdown), activity };
}

const AgentLive = z.object({
  paused: z.object({ reason: z.string() }).nullable(),
  openRequest: z.object({ model: z.string() }).nullable(),
  pendingLlmRequestTrigger: z.object({}).nullable(),
  activeScriptExecutions: z.record(z.string(), z.unknown()),
});

function Conversation({ project, path }: { project: string; path: string }) {
  const { api } = Route.useRouteContext();
  const [context, setContext] = useState<Context>();
  const [events, setEvents] = useState<Map<number, FeedEvent>>(() => new Map());
  const [caughtUp, setCaughtUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const merge = (batch: unknown[]) =>
    setEvents((held) => {
      const next = new Map(held);
      for (const raw of batch) {
        const plain: unknown = JSON.parse(JSON.stringify(raw));
        const row = StreamRow.safeParse(plain);
        const feed = FeedEvent.safeParse(plain);
        if (row.success && feed.success) next.set(row.data.offset, { ...feed.data, ...row.data });
      }
      return next;
    });
  useEffect(() => {
    let disposed = false;
    // What the connect holds so far; released on unmount AND again after the connect settles, since
    // an unmount mid-await comes before the handle that await returns.
    const held: {
      stub?: Project;
      agent?: Context;
      subscription?: { [Symbol.dispose](): void };
    } = {};
    const release = () => {
      held.subscription?.[Symbol.dispose]();
      held.agent?.[Symbol.dispose]();
      held.stub?.[Symbol.dispose]();
      held.subscription = held.agent = held.stub = undefined;
    };
    (async () => {
      held.stub = await api.projects.get(project);
      if (disposed) return;
      const agent = (held.agent = await held.stub.cd(path));
      if (disposed) return;
      // A capnweb stub is a callable proxy: handed to a state setter directly, React would take it
      // for an updater and CALL it (an empty method call the server refuses).
      setContext(() => agent);
      // Subscribe BEFORE the catch-up read, so nothing lands between the two; a push is a batch of
      // committed events, deduped into the map by offset.
      held.subscription = await agent.subscribe({
        consumes: FEED_TYPES,
        target: (batch: unknown[]) => !disposed && merge(batch),
      });
      for (let after = 0; ; ) {
        const page = await agent.readEvents(after, 500);
        if (disposed) return;
        merge(page.events);
        if (page.atHead || page.scannedThroughOffset <= after) break;
        after = page.scannedThroughOffset;
      }
      setCaughtUp(true);
    })()
      .catch((e: unknown) => !disposed && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => disposed && release());
    return () => {
      disposed = true;
      release();
    };
  }, [api, project, path]);

  const live = useLiveState<unknown>(context, {
    key: "agent",
    door: async () =>
      z
        .object({ rev: z.number(), state: z.unknown() })
        .parse(await context!.invoke("itx.facets.get('agent').liveSnapshot()")),
  });
  const view = AgentLive.safeParse(live.value);
  const feed = useMemo(
    () => deriveFeed([...events.values()].sort((a, b) => a.offset - b.offset)),
    [events],
  );
  const status = !view.success
    ? {
        text: live.status === "error" ? `Live state unavailable — ${live.error}` : "Connecting…",
        dot: "",
      }
    : view.data.paused
      ? { text: `Paused — ${view.data.paused.reason}`, dot: "dot-amber" }
      : Object.keys(view.data.activeScriptExecutions).length > 0
        ? {
            text: `Running a script${feed.activity ? ` · ${feed.activity}` : ""}`,
            dot: "dot-green dot-live",
          }
        : view.data.openRequest
          ? { text: `Thinking · ${view.data.openRequest.model}`, dot: "dot-green dot-live" }
          : view.data.pendingLlmRequestTrigger
            ? { text: "About to think", dot: "dot-green dot-live" }
            : { text: "Idle", dot: "" };

  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [feed.rows.length, caughtUp]);

  return (
    <>
      <p className="strip">
        <span className={`dot ${status.dot}`} />
        {status.text}
      </p>
      {error && <p id="error">{error}</p>}
      <div className="feed" aria-live="polite">
        {caughtUp && feed.rows.length === 0 && <p className="muted">Nothing said yet.</p>}
        {feed.rows.map((row) => (
          <FeedRow key={row.offset} row={row} context={context} />
        ))}
        <div ref={end} className="feed-end" />
      </div>
      <Composer project={project} path={path} />
    </>
  );
}

function FeedRow({ row, context }: { row: Row; context: Context | undefined }) {
  switch (row.kind) {
    case "prompt":
      return (
        <details className="script row note">
          <summary>System prompt</summary>
          <pre>{row.text}</pre>
        </details>
      );
    case "user":
      return (
        <div
          className="row user"
          title={`${row.who ? `${row.who} · ` : ""}${new Date(row.at).toLocaleString()}`}
        >
          {row.text}
          {row.files.map((file) => (
            <Attachment key={file.path} file={file} context={context} />
          ))}
        </div>
      );
    case "assistant":
      return (
        <div className="row assistant">
          <Markdown remarkPlugins={[remarkGfm]}>{row.markdown}</Markdown>
        </div>
      );
    case "script":
      return (
        <details className="script row">
          <summary>
            {row.label || "Ran a script"}
            {row.settlement
              ? row.settlement.status === "failed"
                ? " — failed"
                : ""
              : " — running…"}
          </summary>
          <pre>{row.code}</pre>
          {row.settlement && (
            <pre>
              {row.settlement.status === "failed"
                ? row.settlement.error
                : row.settlement.result === undefined
                  ? "(returned nothing)"
                  : JSON.stringify(row.settlement.result, null, 2)}
            </pre>
          )}
        </details>
      );
    case "note":
      return <p className={`row note${row.amber ? " amber" : ""}`}>{row.text}</p>;
  }
}

/** An image attachment renders through a signed URL on the project host; anything else is its name. */
function Attachment({
  file,
  context,
}: {
  file: z.infer<typeof FileAttachment>;
  context: Context | undefined;
}) {
  const [url, setUrl] = useState<string>();
  const image = file.contentType.startsWith("image/");
  useEffect(() => {
    if (!context || !image) return;
    let disposed = false;
    void context
      .invoke(["itx", "files", ["get", file.path], ["url"]])
      .then((signed) => !disposed && setUrl(z.object({ url: z.string() }).parse(signed).url))
      .catch(() => undefined);
    return () => void (disposed = true);
  }, [context, file.path, image]);
  if (image && url) return <img src={url} alt={file.filename} />;
  return (
    <div className="muted">
      {file.filename} · {Math.ceil(file.size / 1024)} KB
    </div>
  );
}

function Composer({ project, path }: { project: string; path: string }) {
  const { api } = Route.useRouteContext();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  async function send() {
    const message = text.trim();
    if (pending || (!message && files.length === 0)) return;
    setPending(true);
    setError(null);
    try {
      const attachments = await Promise.all(
        files.map(
          (file) =>
            new Promise<{ contentType: string; filename: string; data: string }>(
              (resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () =>
                  resolve({
                    contentType: file.type,
                    filename: file.name,
                    data: String(reader.result),
                  });
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(file); // a data: URL — what itx.files.put accepts as a string
              },
            ),
        ),
      );
      using itx = await api.projects.get(project);
      await itx.invoke([
        "itx",
        "agents",
        ["get", path],
        ["message", { message: message || "(see attached)", files: attachments }],
      ]);
      setText("");
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
          }
        }}
        placeholder="Say something to the agent… (Enter sends, Shift+Enter for a new line)"
        aria-label="Message"
      />
      <div className="actions">
        <button type="submit" disabled={pending || (!text.trim() && files.length === 0)}>
          {pending ? "Sending…" : "Send"}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          aria-label="Attach images"
          onChange={(event) => setFiles([...(event.target.files || [])])}
        />
        {error && <span id="error">{error}</span>}
      </div>
    </form>
  );
}
