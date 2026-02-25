import { useCallback, useEffect, useMemo, useState } from "react";
import type { DemoEvent, EgressRecord, MockConfig, RuntimeState } from "./types.ts";

const API_BASE = import.meta.env.VITE_JONASLAND_DEMO_API_BASE ?? "http://127.0.0.1:19099";

type SlackActionResult = {
  status: number;
  ok: boolean;
  body: string;
  threadTs: string;
  channel: string;
  text: string;
};

class HttpError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`HTTP ${String(status)}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(response.status, text);
  }

  return (text.length > 0 ? JSON.parse(text) : {}) as T;
}

function prettyBody(body: string): string {
  if (body.trim().length === 0) return "(empty)";
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function phaseLabel(phase: RuntimeState["phase"]): string {
  if (phase === "idle") return "Idle";
  if (phase === "starting") return "Starting";
  if (phase === "running") return "Running";
  if (phase === "stopping") return "Stopping";
  return "Error";
}

export function App() {
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [records, setRecords] = useState<EgressRecord[]>([]);
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [lastSlackResult, setLastSlackResult] = useState<SlackActionResult | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [promptDraft, setPromptDraft] = useState("<@BOT> what is 50 minus 8");
  const [openaiOutputDraft, setOpenaiOutputDraft] = useState("The answer is 42");
  const [openaiModelDraft, setOpenaiModelDraft] = useState("gpt-4o-mini");
  const [slackResponseOkDraft, setSlackResponseOkDraft] = useState(true);
  const [slackResponseTsDraft, setSlackResponseTsDraft] = useState("123.456");

  const refresh = useCallback(async () => {
    const [nextRuntime, nextEvents, nextRecords] = await Promise.all([
      requestJson<RuntimeState>("/__demo/state"),
      requestJson<{ events: DemoEvent[] }>("/__demo/events"),
      requestJson<{ records: EgressRecord[] }>("/records"),
    ]);

    setRuntime(nextRuntime);
    setEvents(nextEvents.events);
    setRecords(nextRecords.records);

    setOpenaiOutputDraft(nextRuntime.mockConfig.openaiOutputText);
    setOpenaiModelDraft(nextRuntime.mockConfig.openaiModel);
    setSlackResponseOkDraft(nextRuntime.mockConfig.slackResponseOk);
    setSlackResponseTsDraft(nextRuntime.mockConfig.slackResponseTs);
    setPromptDraft(nextRuntime.mockConfig.defaultSlackPrompt);
  }, []);

  useEffect(() => {
    void refresh().catch((error) => {
      setErrorText(error instanceof Error ? error.message : String(error));
    });
  }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      void refresh().catch((error) => {
        setErrorText(error instanceof Error ? error.message : String(error));
      });
    }, 1500);

    return () => clearInterval(interval);
  }, [autoRefresh, refresh]);

  const runAction = useCallback(
    async (action: () => Promise<void>) => {
      setActionBusy(true);
      setErrorText(null);
      try {
        await action();
        await refresh();
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error));
      } finally {
        setActionBusy(false);
      }
    },
    [refresh],
  );

  const onStartSandbox = useCallback(() => {
    void runAction(async () => {
      await requestJson("/__demo/actions/start", { method: "POST", body: "{}" });
    });
  }, [runAction]);

  const onStopSandbox = useCallback(() => {
    void runAction(async () => {
      await requestJson("/__demo/actions/stop", { method: "POST", body: "{}" });
      setLastSlackResult(null);
    });
  }, [runAction]);

  const onSaveMockConfig = useCallback(() => {
    void runAction(async () => {
      await requestJson("/__demo/config", {
        method: "POST",
        body: JSON.stringify({
          openaiOutputText: openaiOutputDraft,
          openaiModel: openaiModelDraft,
          slackResponseOk: slackResponseOkDraft,
          slackResponseTs: slackResponseTsDraft,
          defaultSlackPrompt: promptDraft,
        } satisfies Partial<MockConfig>),
      });
    });
  }, [
    openaiModelDraft,
    openaiOutputDraft,
    promptDraft,
    runAction,
    slackResponseOkDraft,
    slackResponseTsDraft,
  ]);

  const onSimulateSlack = useCallback(() => {
    void runAction(async () => {
      const payload = await requestJson<{ result: SlackActionResult }>(
        "/__demo/actions/simulate-slack",
        {
          method: "POST",
          body: JSON.stringify({ text: promptDraft }),
        },
      );
      setLastSlackResult(payload.result);
    });
  }, [promptDraft, runAction]);

  const onClearRecords = useCallback(() => {
    void runAction(async () => {
      await requestJson("/records/clear", { method: "POST", body: "{}" });
    });
  }, [runAction]);

  const disableActions = actionBusy || runtime?.busy === true;
  const isRunning = runtime?.phase === "running";

  const phaseTone = useMemo(() => {
    if (runtime?.phase === "running") return "is-running";
    if (runtime?.phase === "starting" || runtime?.phase === "stopping") return "is-pending";
    if (runtime?.phase === "error") return "is-error";
    return "is-idle";
  }, [runtime?.phase]);

  return (
    <div className="page-shell">
      <header className="hero-panel">
        <p className="kicker">Jonas Land Demo Control</p>
        <h1>Sandbox + Egress Workbench</h1>
        <p className="lede">
          Start a sandbox, simulate Slack webhooks, and inspect every mocked third-party request and
          response.
        </p>
        <div className={`phase-pill ${phaseTone}`}>
          {runtime ? phaseLabel(runtime.phase) : "Loading"}
        </div>
      </header>

      <main className="grid-layout">
        <section className="panel">
          <h2>Sandbox</h2>
          <div className="row-actions">
            <button disabled={disableActions || isRunning} onClick={onStartSandbox}>
              Start Sandbox
            </button>
            <button
              className="danger"
              disabled={disableActions || !runtime || !isRunning}
              onClick={onStopSandbox}
            >
              Stop Sandbox
            </button>
            <button className="ghost" disabled={disableActions} onClick={() => void refresh()}>
              Refresh
            </button>
          </div>

          <dl className="meta-grid">
            <dt>Container</dt>
            <dd>{runtime?.containerName ?? "-"}</dd>
            <dt>Ingress URL</dt>
            <dd>{runtime?.ingressUrl ?? "-"}</dd>
            <dt>Sandbox image</dt>
            <dd>{runtime?.image ?? "-"}</dd>
            <dt>Egress target</dt>
            <dd>{runtime?.externalEgressProxy ?? "-"}</dd>
          </dl>
        </section>

        <section className="panel">
          <h2>Mock Behavior</h2>
          <label>
            Slack prompt to send
            <textarea
              value={promptDraft}
              onChange={(event) => setPromptDraft(event.target.value)}
              rows={3}
            />
          </label>
          <label>
            Mock OpenAI output text
            <textarea
              value={openaiOutputDraft}
              onChange={(event) => setOpenaiOutputDraft(event.target.value)}
              rows={4}
            />
          </label>

          <div className="row-split">
            <label>
              OpenAI model label
              <input
                value={openaiModelDraft}
                onChange={(event) => setOpenaiModelDraft(event.target.value)}
              />
            </label>
            <label>
              Slack timestamp
              <input
                value={slackResponseTsDraft}
                onChange={(event) => setSlackResponseTsDraft(event.target.value)}
              />
            </label>
          </div>

          <label className="checkbox-row">
            <input
              checked={slackResponseOkDraft}
              onChange={(event) => setSlackResponseOkDraft(event.target.checked)}
              type="checkbox"
            />
            Slack post returns ok=true
          </label>

          <div className="row-actions">
            <button disabled={disableActions} onClick={onSaveMockConfig}>
              Save Mock Config
            </button>
            <button disabled={disableActions || !isRunning} onClick={onSimulateSlack}>
              Simulate Slack Webhook
            </button>
            <button className="ghost" disabled={disableActions} onClick={onClearRecords}>
              Clear Captures
            </button>
          </div>

          {lastSlackResult ? (
            <pre className="result-block">{JSON.stringify(lastSlackResult, null, 2)}</pre>
          ) : null}
        </section>

        <section className="panel panel-full">
          <div className="panel-head">
            <h2>Captured Third-Party Traffic</h2>
            <label className="checkbox-row compact">
              <input
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.target.checked)}
                type="checkbox"
              />
              Auto refresh
            </label>
          </div>

          {records.length === 0 ? (
            <p className="empty">No requests captured yet.</p>
          ) : (
            <div className="record-list">
              {records
                .slice()
                .reverse()
                .map((record) => (
                  <article className="record-card" key={record.id}>
                    <div className="record-head">
                      <strong>
                        {record.method} {record.path}
                      </strong>
                      <span>
                        {record.responseStatus} in {record.durationMs}ms
                      </span>
                    </div>
                    <p className="record-host">host={record.host}</p>
                    <div className="record-grid">
                      <div>
                        <h3>Request</h3>
                        <pre>{prettyBody(record.requestBody)}</pre>
                      </div>
                      <div>
                        <h3>Response</h3>
                        <pre>{prettyBody(record.responseBody)}</pre>
                      </div>
                    </div>
                  </article>
                ))}
            </div>
          )}
        </section>

        <section className="panel panel-full">
          <h2>Runtime Events</h2>
          {events.length === 0 ? (
            <p className="empty">No events yet.</p>
          ) : (
            <ul className="event-list">
              {events
                .slice()
                .reverse()
                .map((event) => (
                  <li key={event.id}>
                    <time>{event.createdAt}</time>
                    <span>{event.message}</span>
                  </li>
                ))}
            </ul>
          )}
        </section>
      </main>

      {errorText ? <aside className="error-banner">{errorText}</aside> : null}
    </div>
  );
}
