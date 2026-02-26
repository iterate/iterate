import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  JonaslandDemoProvider,
  JonaslandDemoState,
  JonaslandEgressFallbackMode,
  JonaslandMockRule,
  SimulateSlackResult,
} from "./types.ts";

const API_BASE = import.meta.env.VITE_JONASLAND_DEMO_API_BASE ?? "http://127.0.0.1:19099";

type RuleDraft = {
  id: string | null;
  name: string;
  enabled: boolean;
  method: string;
  hostPattern: string;
  pathPattern: string;
  responseStatus: string;
  responseHeadersJson: string;
  responseBody: string;
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

const NEW_RULE_DRAFT: RuleDraft = {
  id: null,
  name: "",
  enabled: true,
  method: "POST",
  hostPattern: "",
  pathPattern: "",
  responseStatus: "200",
  responseHeadersJson: '{\n  "content-type": "application/json; charset=utf-8"\n}',
  responseBody: "{}",
};

function prettyBody(body: string): string {
  if (body.trim().length === 0) return "(empty)";
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function phaseLabel(phase: JonaslandDemoState["phase"]): string {
  if (phase === "idle") return "Idle";
  if (phase === "starting") return "Starting";
  if (phase === "running") return "Running";
  if (phase === "stopping") return "Stopping";
  return "Error";
}

async function requestOrpc<T>(procedure: string, input: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}/orpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: input }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(response.status, text);
  }

  const parsed = (text.length > 0 ? JSON.parse(text) : {}) as { json: T };
  return parsed.json;
}

function normalizeRuleDraft(rule: JonaslandMockRule): RuleDraft {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    method: rule.method,
    hostPattern: rule.hostPattern,
    pathPattern: rule.pathPattern,
    responseStatus: String(rule.responseStatus),
    responseHeadersJson: JSON.stringify(rule.responseHeaders, null, 2),
    responseBody: rule.responseBody,
  };
}

export function App() {
  const [state, setState] = useState<JonaslandDemoState | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [providerDraft, setProviderDraft] = useState<JonaslandDemoProvider>("docker");
  const [fallbackModeDraft, setFallbackModeDraft] =
    useState<JonaslandEgressFallbackMode>("deny-all");
  const [promptDraft, setPromptDraft] = useState("<@BOT> what is 50 minus 8");
  const [lastSlackResult, setLastSlackResult] = useState<SimulateSlackResult | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(NEW_RULE_DRAFT);

  const hasLoadedInitialDrafts = useRef(false);

  const refresh = useCallback(async (options?: { syncDrafts?: boolean }) => {
    const next = await requestOrpc<JonaslandDemoState>("demo.getState", {});
    setState(next);

    const shouldSync = options?.syncDrafts === true || !hasLoadedInitialDrafts.current;
    if (shouldSync) {
      setProviderDraft(next.provider);
      setFallbackModeDraft(next.config.fallbackMode);
      setPromptDraft(next.config.defaultSlackPrompt);
      hasLoadedInitialDrafts.current = true;
    }
  }, []);

  useEffect(() => {
    void refresh({ syncDrafts: true }).catch((error) => {
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
    async (action: () => Promise<void>, options?: { syncDrafts?: boolean }) => {
      setActionBusy(true);
      setErrorText(null);
      try {
        await action();
        await refresh({ syncDrafts: options?.syncDrafts === true });
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : String(error));
      } finally {
        setActionBusy(false);
      }
    },
    [refresh],
  );

  const onSetProvider = useCallback(
    (provider: JonaslandDemoProvider) => {
      setProviderDraft(provider);
      void runAction(async () => {
        const next = await requestOrpc<JonaslandDemoState>("demo.setProvider", { provider });
        setState(next);
      });
    },
    [runAction],
  );

  const onStart = useCallback(() => {
    void runAction(async () => {
      const next = await requestOrpc<JonaslandDemoState>("demo.startSandbox", {});
      setState(next);
    });
  }, [runAction]);

  const onStop = useCallback(() => {
    void runAction(async () => {
      const next = await requestOrpc<JonaslandDemoState>("demo.stopSandbox", {});
      setState(next);
      setLastSlackResult(null);
    });
  }, [runAction]);

  const onSaveConfig = useCallback(() => {
    void runAction(
      async () => {
        const next = await requestOrpc<JonaslandDemoState>("demo.patchConfig", {
          fallbackMode: fallbackModeDraft,
          defaultSlackPrompt: promptDraft,
        });
        setState(next);
      },
      { syncDrafts: true },
    );
  }, [fallbackModeDraft, promptDraft, runAction]);

  const onSimulateSlack = useCallback(() => {
    void runAction(async () => {
      const payload = await requestOrpc<{ state: JonaslandDemoState; result: SimulateSlackResult }>(
        "demo.simulateSlackWebhook",
        { text: promptDraft },
      );
      setState(payload.state);
      setLastSlackResult(payload.result);
    });
  }, [promptDraft, runAction]);

  const onClearRecords = useCallback(() => {
    void runAction(async () => {
      const next = await requestOrpc<JonaslandDemoState>("demo.clearRecords", {});
      setState(next);
    });
  }, [runAction]);

  const onLoadRule = useCallback((rule: JonaslandMockRule) => {
    setRuleDraft(normalizeRuleDraft(rule));
  }, []);

  const onResetRuleDraft = useCallback(() => {
    setRuleDraft(NEW_RULE_DRAFT);
  }, []);

  const onSaveRule = useCallback(() => {
    void runAction(async () => {
      let parsedHeaders: Record<string, string> = {};
      try {
        const parsed = JSON.parse(ruleDraft.responseHeadersJson) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          parsedHeaders = Object.fromEntries(
            Object.entries(parsed)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string")
              .map(([key, value]) => [key, value]),
          );
        }
      } catch {
        throw new Error("response headers JSON is invalid");
      }

      const status = Number.parseInt(ruleDraft.responseStatus, 10);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new Error("response status must be an integer between 100 and 599");
      }

      const next = await requestOrpc<JonaslandDemoState>("demo.upsertMockRule", {
        ...(ruleDraft.id ? { id: ruleDraft.id } : {}),
        name: ruleDraft.name,
        enabled: ruleDraft.enabled,
        method: ruleDraft.method,
        hostPattern: ruleDraft.hostPattern,
        pathPattern: ruleDraft.pathPattern,
        responseStatus: status,
        responseHeaders: parsedHeaders,
        responseBody: ruleDraft.responseBody,
      });

      setState(next);
      onResetRuleDraft();
    });
  }, [onResetRuleDraft, ruleDraft, runAction]);

  const onDeleteRule = useCallback(
    (id: string) => {
      void runAction(async () => {
        const next = await requestOrpc<JonaslandDemoState>("demo.deleteMockRule", { id });
        setState(next);
        if (ruleDraft.id === id) {
          onResetRuleDraft();
        }
      });
    },
    [onResetRuleDraft, ruleDraft.id, runAction],
  );

  const disableActions = actionBusy || state?.busy === true;
  const isRunning = state?.phase === "running";
  const canStop = state !== null && state.phase !== "idle";

  const phaseTone = useMemo(() => {
    if (state?.phase === "running") return "is-running";
    if (state?.phase === "starting" || state?.phase === "stopping") return "is-pending";
    if (state?.phase === "error") return "is-error";
    return "is-idle";
  }, [state?.phase]);

  return (
    <div className="page-shell">
      <header className="hero-panel">
        <p className="kicker">Jonas Land Demo Control</p>
        <h1>State-Driven Sandbox + Egress Lab</h1>
        <p className="lede">
          One in-memory JonaslandDemoState drives sandbox lifecycle, mock egress behavior, and the
          request/response firehose.
        </p>
        <div className={`phase-pill ${phaseTone}`}>
          {state ? phaseLabel(state.phase) : "Loading"}
        </div>
      </header>

      <main className="grid-layout">
        <section className="panel">
          <h2>Provider + Sandbox</h2>
          <label>
            Provider
            <select
              disabled={disableActions || (state !== null && state.phase !== "idle")}
              onChange={(event) => onSetProvider(event.target.value as JonaslandDemoProvider)}
              value={providerDraft}
            >
              <option value="docker">docker</option>
              <option value="fly">fly (not implemented)</option>
            </select>
          </label>

          <div className="row-actions">
            <button disabled={disableActions || isRunning} onClick={onStart}>
              Start Sandbox
            </button>
            <button className="danger" disabled={disableActions || !canStop} onClick={onStop}>
              Stop Sandbox
            </button>
            <button
              className="ghost"
              disabled={disableActions}
              onClick={() => void refresh({ syncDrafts: true })}
            >
              Refresh
            </button>
          </div>

          <dl className="meta-grid">
            <dt>Container</dt>
            <dd>{state?.sandbox.containerName ?? "-"}</dd>
            <dt>Ingress URL</dt>
            <dd>{state?.sandbox.ingressUrl ?? "-"}</dd>
            <dt>Home URL</dt>
            <dd>
              {state?.links.home ? (
                <a href={state.links.home} rel="noreferrer" target="_blank">
                  {state.links.home}
                </a>
              ) : (
                "-"
              )}
            </dd>
            <dt>Egress target</dt>
            <dd>{state?.sandbox.externalEgressProxy ?? "-"}</dd>
          </dl>
        </section>

        <section className="panel">
          <h2>Egress Policy</h2>
          <label>
            Fallback mode
            <select
              disabled={disableActions}
              onChange={(event) =>
                setFallbackModeDraft(event.target.value as JonaslandEgressFallbackMode)
              }
              value={fallbackModeDraft}
            >
              <option value="deny-all">deny-all</option>
              <option value="proxy-internet">proxy-internet</option>
            </select>
          </label>

          <label>
            Default Slack prompt
            <textarea
              onChange={(event) => setPromptDraft(event.target.value)}
              rows={3}
              value={promptDraft}
            />
          </label>

          <div className="row-actions">
            <button disabled={disableActions} onClick={onSaveConfig}>
              Save Config
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
          <h2>Mock Rules</h2>

          <div className="row-split">
            <label>
              Name
              <input
                onChange={(event) =>
                  setRuleDraft((prev) => ({ ...prev, name: event.target.value }))
                }
                value={ruleDraft.name}
              />
            </label>
            <label>
              Method
              <input
                onChange={(event) =>
                  setRuleDraft((prev) => ({ ...prev, method: event.target.value.toUpperCase() }))
                }
                value={ruleDraft.method}
              />
            </label>
          </div>

          <div className="row-split">
            <label>
              Host pattern (`*` supported)
              <input
                onChange={(event) =>
                  setRuleDraft((prev) => ({ ...prev, hostPattern: event.target.value }))
                }
                value={ruleDraft.hostPattern}
              />
            </label>
            <label>
              Path pattern (`*` supported)
              <input
                onChange={(event) =>
                  setRuleDraft((prev) => ({ ...prev, pathPattern: event.target.value }))
                }
                value={ruleDraft.pathPattern}
              />
            </label>
          </div>

          <div className="row-split">
            <label>
              Response status
              <input
                onChange={(event) =>
                  setRuleDraft((prev) => ({ ...prev, responseStatus: event.target.value }))
                }
                value={ruleDraft.responseStatus}
              />
            </label>
            <label className="checkbox-row">
              <input
                checked={ruleDraft.enabled}
                onChange={(event) =>
                  setRuleDraft((prev) => ({ ...prev, enabled: event.target.checked }))
                }
                type="checkbox"
              />
              Rule enabled
            </label>
          </div>

          <label>
            Response headers (JSON object)
            <textarea
              onChange={(event) =>
                setRuleDraft((prev) => ({ ...prev, responseHeadersJson: event.target.value }))
              }
              rows={5}
              value={ruleDraft.responseHeadersJson}
            />
          </label>

          <label>
            Response body
            <textarea
              onChange={(event) =>
                setRuleDraft((prev) => ({ ...prev, responseBody: event.target.value }))
              }
              rows={8}
              value={ruleDraft.responseBody}
            />
          </label>

          <div className="row-actions">
            <button disabled={disableActions} onClick={onSaveRule}>
              {ruleDraft.id ? "Update Rule" : "Add Rule"}
            </button>
            <button className="ghost" disabled={disableActions} onClick={onResetRuleDraft}>
              New Rule
            </button>
          </div>

          {state?.config.mockRules.length ? (
            <div className="record-list">
              {state.config.mockRules.map((rule) => (
                <article className="record-card" key={rule.id}>
                  <div className="record-head">
                    <strong>
                      {rule.method} {rule.hostPattern}
                      {rule.pathPattern}
                    </strong>
                    <span>{rule.enabled ? "enabled" : "disabled"}</span>
                  </div>
                  <p className="record-host">
                    {rule.name} | {rule.responseStatus}
                  </p>
                  <div className="row-actions">
                    <button
                      className="ghost"
                      disabled={disableActions}
                      onClick={() => onLoadRule(rule)}
                    >
                      Edit
                    </button>
                    <button
                      className="danger"
                      disabled={disableActions}
                      onClick={() => onDeleteRule(rule.id)}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="empty">No mock rules configured.</p>
          )}
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

          {state?.records.length ? (
            <div className="record-list">
              {state.records
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
          ) : (
            <p className="empty">No requests captured yet.</p>
          )}
        </section>

        <section className="panel panel-full">
          <h2>Runtime Events</h2>
          {state?.events.length ? (
            <ul className="event-list">
              {state.events
                .slice()
                .reverse()
                .map((event) => (
                  <li key={event.id}>
                    <time>{event.createdAt}</time>
                    <span>{event.message}</span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="empty">No events yet.</p>
          )}
        </section>
      </main>

      {errorText ? <aside className="error-banner">{errorText}</aside> : null}
    </div>
  );
}
