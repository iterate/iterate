import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { Label } from "@iterate-com/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { Separator } from "@iterate-com/ui/components/separator";
import { Switch } from "@iterate-com/ui/components/switch";
import { Textarea } from "@iterate-com/ui/components/textarea";
import type {
  JonaslandDemoMutationResult,
  JonaslandDemoProvider,
  JonaslandDemoState,
  JonaslandEgressFallbackMode,
  JonaslandMockRule,
  SimulateSlackResult,
} from "./types.ts";

const API_BASE = import.meta.env.VITE_JONASLAND_DEMO_API_BASE ?? "http://127.0.0.1:19099";
const DEFAULT_LOG_COMMAND =
  "tail -n 120 -f /var/log/pidnap/process/daemon*.log /var/log/pidnap/process/daemon.log 2>/dev/null";

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

function firstHeaderValue(headers: Record<string, string | string[]>, key: string): string | null {
  const value = headers[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    return typeof first === "string" ? first : null;
  }
  return null;
}

function displayEgressTargetHost(
  headers: Record<string, string | string[]>,
  fallbackHost: string,
): string {
  const forwardedHost = firstHeaderValue(headers, "x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedHost && forwardedHost.length > 0) return forwardedHost;

  const originalHost = firstHeaderValue(headers, "x-iterate-original-host")?.split(",")[0]?.trim();
  if (originalHost && originalHost.length > 0) return originalHost;

  return fallbackHost;
}

function phaseBadgeVariant(
  phase: JonaslandDemoState["phase"],
): "default" | "secondary" | "destructive" | "outline" {
  if (phase === "running") return "default";
  if (phase === "error") return "destructive";
  if (phase === "idle") return "secondary";
  return "outline";
}

function phaseLabel(phase: JonaslandDemoState["phase"]): string {
  if (phase === "idle") return "Idle";
  if (phase === "starting") return "Starting";
  if (phase === "running") return "Running";
  if (phase === "stopping") return "Stopping";
  return "Error";
}

function renderDaemonStreamEventFrame(frame: string): string | null {
  const trimmed = frame.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;

  const lines = trimmed.split("\n");
  const eventName =
    lines
      .find((line) => line.startsWith("event:"))
      ?.slice("event:".length)
      .trim() ?? "";
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n")
    .trim();

  if (!data) return null;
  if (eventName === "done") return null;

  try {
    const parsed = JSON.parse(data) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "json" in parsed &&
      typeof (parsed as { json?: unknown }).json === "object" &&
      (parsed as { json?: unknown }).json !== null
    ) {
      const row = (parsed as { json: Record<string, unknown> }).json;
      const stream = typeof row.stream === "string" ? row.stream : "log";
      const text = typeof row.text === "string" ? row.text : JSON.stringify(row);
      const exitCode = typeof row.exitCode === "number" ? ` exit=${String(row.exitCode)}` : "";
      const signal = typeof row.signal === "string" ? ` signal=${row.signal}` : "";
      return `[${stream}] ${text}${exitCode}${signal}`;
    }
  } catch {
    return data;
  }

  return data;
}

function parseStateUpdateFrame(frame: string): JonaslandDemoState | null {
  const trimmed = frame.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;

  const data = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n")
    .trim();

  if (!data) return null;

  try {
    const parsed = JSON.parse(data) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!("json" in parsed)) return null;
    const snapshot = (parsed as { json?: unknown }).json;
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return null;
    return snapshot as JonaslandDemoState;
  } catch {
    return null;
  }
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

  const [providerDraft, setProviderDraft] = useState<JonaslandDemoProvider>("docker");
  const [fallbackModeDraft, setFallbackModeDraft] =
    useState<JonaslandEgressFallbackMode>("deny-all");
  const [promptDraft, setPromptDraft] = useState("<@BOT> what is 50 minus 8");
  const [lastSlackResult, setLastSlackResult] = useState<SimulateSlackResult | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(NEW_RULE_DRAFT);

  const [logCommandDraft, setLogCommandDraft] = useState(DEFAULT_LOG_COMMAND);
  const [logOutput, setLogOutput] = useState("");
  const [logStreamError, setLogStreamError] = useState<string | null>(null);
  const [isLogStreaming, setIsLogStreaming] = useState(false);
  const logAbortRef = useRef<AbortController | null>(null);
  const stateStreamAbortRef = useRef<AbortController | null>(null);
  const stateStreamReconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasLoadedInitialDrafts = useRef(false);

  const applyIncomingState = useCallback(
    (next: JonaslandDemoState, options?: { syncDrafts?: boolean }) => {
      setState(next);

      const shouldSync = options?.syncDrafts === true || !hasLoadedInitialDrafts.current;
      if (shouldSync) {
        setProviderDraft(next.provider);
        setFallbackModeDraft(next.config.fallbackMode);
        setPromptDraft(next.config.defaultSlackPrompt);
        hasLoadedInitialDrafts.current = true;
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    const next = await requestOrpc<JonaslandDemoState>("demo.getState", {});
    applyIncomingState(next, { syncDrafts: true });
  }, [applyIncomingState]);

  useEffect(() => {
    let closed = false;

    const clearReconnect = () => {
      if (stateStreamReconnectRef.current) {
        clearTimeout(stateStreamReconnectRef.current);
        stateStreamReconnectRef.current = null;
      }
    };

    const connect = async () => {
      clearReconnect();

      const controller = new AbortController();
      stateStreamAbortRef.current = controller;

      try {
        const response = await fetch(`${API_BASE}/orpc/demo.stateUpdates`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: {} }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`state stream failed (${String(response.status)})`);
        }

        if (response.body === null) {
          throw new Error("state stream missing response body");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let frameBuffer = "";

        const consumeFrames = (chunk: string, flush: boolean): void => {
          frameBuffer += chunk;
          const frames = frameBuffer.split("\n\n");
          if (!flush) {
            frameBuffer = frames.pop() ?? "";
          } else {
            frameBuffer = "";
          }

          for (const frame of frames) {
            const next = parseStateUpdateFrame(frame);
            if (next !== null) {
              applyIncomingState(next);
            }
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          consumeFrames(chunk, false);
        }

        consumeFrames(decoder.decode(), true);
      } catch (error) {
        if (!controller.signal.aborted && !closed) {
          setErrorText(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (stateStreamAbortRef.current === controller) {
          stateStreamAbortRef.current = null;
        }

        if (!closed) {
          stateStreamReconnectRef.current = setTimeout(() => {
            void connect();
          }, 1_000);
        }
      }
    };

    void refresh().catch(() => {});
    void connect();

    return () => {
      closed = true;
      clearReconnect();
      stateStreamAbortRef.current?.abort();
      stateStreamAbortRef.current = null;
    };
  }, [applyIncomingState, refresh]);

  useEffect(() => {
    return () => {
      logAbortRef.current?.abort();
    };
  }, []);

  const runAction = useCallback(async (action: () => Promise<void>) => {
    setActionBusy(true);
    setErrorText(null);
    try {
      await action();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy(false);
    }
  }, []);

  const onSetProvider = useCallback(
    (provider: JonaslandDemoProvider) => {
      setProviderDraft(provider);
      void runAction(async () => {
        const next = await requestOrpc<JonaslandDemoMutationResult>("demo.mutateState", {
          type: "set-provider",
          provider,
        });
        applyIncomingState(next.state, { syncDrafts: true });
      });
    },
    [applyIncomingState, runAction],
  );

  const onStart = useCallback(() => {
    void runAction(async () => {
      const next = await requestOrpc<JonaslandDemoMutationResult>("demo.mutateState", {
        type: "start-sandbox",
      });
      applyIncomingState(next.state);
    });
  }, [applyIncomingState, runAction]);

  const onStop = useCallback(() => {
    void runAction(async () => {
      const next = await requestOrpc<JonaslandDemoMutationResult>("demo.mutateState", {
        type: "stop-sandbox",
      });
      applyIncomingState(next.state);
      setLastSlackResult(null);
      logAbortRef.current?.abort();
      setIsLogStreaming(false);
    });
  }, [applyIncomingState, runAction]);

  const onSaveConfig = useCallback(() => {
    void runAction(async () => {
      const next = await requestOrpc<JonaslandDemoMutationResult>("demo.mutateState", {
        type: "patch-config",
        patch: {
          fallbackMode: fallbackModeDraft,
          defaultSlackPrompt: promptDraft,
        },
      });
      applyIncomingState(next.state, { syncDrafts: true });
    });
  }, [applyIncomingState, fallbackModeDraft, promptDraft, runAction]);

  const onSimulateSlack = useCallback(() => {
    void runAction(async () => {
      const payload = await requestOrpc<JonaslandDemoMutationResult>("demo.mutateState", {
        type: "simulate-slack-webhook",
        input: { text: promptDraft },
      });
      applyIncomingState(payload.state);
      setLastSlackResult(payload.result ?? null);
    });
  }, [applyIncomingState, promptDraft, runAction]);

  const onClearRecords = useCallback(() => {
    void runAction(async () => {
      const next = await requestOrpc<JonaslandDemoMutationResult>("demo.mutateState", {
        type: "clear-records",
      });
      applyIncomingState(next.state);
    });
  }, [applyIncomingState, runAction]);

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

      const next = await requestOrpc<JonaslandDemoMutationResult>("demo.mutateState", {
        type: "upsert-mock-rule",
        rule: {
          ...(ruleDraft.id ? { id: ruleDraft.id } : {}),
          name: ruleDraft.name,
          enabled: ruleDraft.enabled,
          method: ruleDraft.method,
          hostPattern: ruleDraft.hostPattern,
          pathPattern: ruleDraft.pathPattern,
          responseStatus: status,
          responseHeaders: parsedHeaders,
          responseBody: ruleDraft.responseBody,
        },
      });

      applyIncomingState(next.state);
      onResetRuleDraft();
    });
  }, [applyIncomingState, onResetRuleDraft, ruleDraft, runAction]);

  const onDeleteRule = useCallback(
    (id: string) => {
      void runAction(async () => {
        const next = await requestOrpc<JonaslandDemoMutationResult>("demo.mutateState", {
          type: "delete-mock-rule",
          id,
        });
        applyIncomingState(next.state);
        if (ruleDraft.id === id) {
          onResetRuleDraft();
        }
      });
    },
    [applyIncomingState, onResetRuleDraft, ruleDraft.id, runAction],
  );

  const startLogStream = useCallback(() => {
    if (isLogStreaming) return;

    const command = logCommandDraft.trim();
    if (!command) {
      setLogStreamError("log command is required");
      return;
    }

    setLogStreamError(null);
    setLogOutput("");

    const controller = new AbortController();
    logAbortRef.current = controller;
    setIsLogStreaming(true);

    const params = new URLSearchParams({ command });
    const streamUrl = `${API_BASE}/__demo/streams/daemon-logs?${params.toString()}`;

    void (async () => {
      try {
        const response = await fetch(streamUrl, {
          method: "GET",
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`daemon log stream failed (${String(response.status)})`);
        }

        if (response.body === null) {
          throw new Error("daemon log stream missing body");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let frameBuffer = "";

        const consumeFrames = (chunk: string, flush: boolean): void => {
          frameBuffer += chunk;

          const frames = frameBuffer.split("\n\n");
          if (!flush) {
            frameBuffer = frames.pop() ?? "";
          } else {
            frameBuffer = "";
          }

          for (const frame of frames) {
            const rendered = renderDaemonStreamEventFrame(frame);
            if (rendered !== null) {
              setLogOutput((prev) => `${prev}${rendered}\n`);
            }
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          consumeFrames(chunk, false);
        }

        const rest = decoder.decode();
        consumeFrames(rest, true);
      } catch (error) {
        if (!controller.signal.aborted) {
          setLogStreamError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (logAbortRef.current === controller) {
          logAbortRef.current = null;
        }
        setIsLogStreaming(false);
      }
    })();
  }, [isLogStreaming, logCommandDraft]);

  const stopLogStream = useCallback(() => {
    logAbortRef.current?.abort();
    logAbortRef.current = null;
    setIsLogStreaming(false);
  }, []);

  const disableActions = actionBusy || state?.busy === true;
  const isRunning = state?.phase === "running";
  const canStop = state !== null && state.phase !== "idle";

  const records = state?.records ?? [];
  const events = state?.events ?? [];

  const phase = useMemo(() => state?.phase ?? "idle", [state?.phase]);
  const hasDeployment = useMemo(() => {
    return Boolean(state?.sandbox.containerName) || Boolean(state?.sandbox.ingressUrl);
  }, [state?.sandbox.containerName, state?.sandbox.ingressUrl]);
  const isStarting = phase === "starting";
  const isStopping = phase === "stopping";
  const showRuntimePanels = phase === "running";
  const recentEvents = useMemo(() => events.slice().reverse().slice(0, 20), [events]);

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 md:p-6">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-2xl font-semibold">Mock Demo OS</h1>
            <Badge variant={phaseBadgeVariant(phase)}>{phaseLabel(phase)}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Create a deployment, poke it from outside, and let this page host act as that
            deployment&apos;s egress proxy.
          </p>
          {state?.links.home ? (
            <Button asChild className="h-16 w-full max-w-lg text-lg md:text-xl" size="lg">
              <a href={state.links.home} rel="noreferrer" target="_blank">
                Open Sandbox Home App
              </a>
            </Button>
          ) : null}
          {errorText ? <p className="text-sm text-destructive">{errorText}</p> : null}
        </header>

        <Separator />

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-3">
            <h2 className="text-lg font-medium">Deployment</h2>
            <div className="space-y-2">
              <Label htmlFor="provider">Provider</Label>
              <NativeSelect
                id="provider"
                disabled={disableActions || (state !== null && state.phase !== "idle")}
                onChange={(event) =>
                  onSetProvider(event.currentTarget.value as JonaslandDemoProvider)
                }
                value={providerDraft}
              >
                <NativeSelectOption value="docker">docker</NativeSelectOption>
                <NativeSelectOption value="fly">fly (not implemented)</NativeSelectOption>
              </NativeSelect>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={disableActions || isRunning} onClick={onStart} type="button">
                Start Sandbox
              </Button>
              <Button
                disabled={disableActions || !canStop}
                onClick={onStop}
                type="button"
                variant="destructive"
              >
                Stop Sandbox
              </Button>
              <Button
                disabled={disableActions}
                onClick={() => void refresh()}
                type="button"
                variant="outline"
              >
                Refresh
              </Button>
            </div>
            <dl className="grid grid-cols-[120px_1fr] gap-2 text-sm">
              <dt className="text-muted-foreground">Container</dt>
              <dd className="font-mono text-xs break-all">{state?.sandbox.containerName ?? "-"}</dd>
              <dt className="text-muted-foreground">Ingress</dt>
              <dd className="font-mono text-xs break-all">{state?.sandbox.ingressUrl ?? "-"}</dd>
              <dt className="text-muted-foreground">Egress Proxy</dt>
              <dd className="font-mono text-xs break-all">
                {state?.sandbox.externalEgressProxy ?? "-"}
              </dd>
            </dl>
          </div>

          {showRuntimePanels ? (
            <div className="space-y-3">
              <h2 className="text-lg font-medium">Egress Scenario</h2>
              <div className="space-y-2">
                <Label htmlFor="fallback">Fallback mode</Label>
                <NativeSelect
                  id="fallback"
                  disabled={disableActions}
                  onChange={(event) =>
                    setFallbackModeDraft(event.currentTarget.value as JonaslandEgressFallbackMode)
                  }
                  value={fallbackModeDraft}
                >
                  <NativeSelectOption value="deny-all">deny-all</NativeSelectOption>
                  <NativeSelectOption value="proxy-internet">proxy-internet</NativeSelectOption>
                </NativeSelect>
              </div>
              <div className="space-y-2">
                <Label htmlFor="default-prompt">Default Slack prompt</Label>
                <Textarea
                  id="default-prompt"
                  onChange={(event) => setPromptDraft(event.currentTarget.value)}
                  rows={3}
                  value={promptDraft}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button disabled={disableActions} onClick={onSaveConfig} type="button">
                  Save Config
                </Button>
                <Button
                  disabled={disableActions || !isRunning}
                  onClick={onSimulateSlack}
                  type="button"
                  variant="secondary"
                >
                  Simulate Slack Webhook
                </Button>
                <Button
                  disabled={disableActions}
                  onClick={onClearRecords}
                  type="button"
                  variant="outline"
                >
                  Clear Captures
                </Button>
              </div>
              {lastSlackResult ? <pre>{JSON.stringify(lastSlackResult, null, 2)}</pre> : null}
            </div>
          ) : null}
        </section>

        {showRuntimePanels ? (
          <>
            <Separator />

            <section className="space-y-3">
              <h2 className="text-lg font-medium">Daemon Log Stream</h2>
              <p className="text-sm text-muted-foreground">
                Runs a daemon shell command through oRPC streaming and shows decoded stream rows.
              </p>
              <Input
                value={logCommandDraft}
                onChange={(event) => setLogCommandDraft(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!isRunning || isLogStreaming}
                  onClick={startLogStream}
                  type="button"
                >
                  Stream Logs
                </Button>
                <Button
                  disabled={!isLogStreaming}
                  onClick={stopLogStream}
                  type="button"
                  variant="outline"
                >
                  Stop Stream
                </Button>
              </div>
              {logStreamError ? <p className="text-sm text-destructive">{logStreamError}</p> : null}
              <pre>{logOutput.length > 0 ? logOutput : "(no streamed output yet)"}</pre>
            </section>

            <Separator />

            <section className="space-y-3">
              <h2 className="text-lg font-medium">Mock Rules</h2>
              <p className="text-sm text-muted-foreground">
                Match outbound method/host/path (`*` wildcard) before fallback mode is used.
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="rule-name">Name</Label>
                  <Input
                    id="rule-name"
                    onChange={(event) =>
                      setRuleDraft((prev) => ({ ...prev, name: event.target.value }))
                    }
                    value={ruleDraft.name}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rule-method">Method</Label>
                  <Input
                    id="rule-method"
                    onChange={(event) =>
                      setRuleDraft((prev) => ({
                        ...prev,
                        method: event.target.value.toUpperCase(),
                      }))
                    }
                    value={ruleDraft.method}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rule-host">Host pattern</Label>
                  <Input
                    id="rule-host"
                    onChange={(event) =>
                      setRuleDraft((prev) => ({ ...prev, hostPattern: event.target.value }))
                    }
                    value={ruleDraft.hostPattern}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rule-path">Path pattern</Label>
                  <Input
                    id="rule-path"
                    onChange={(event) =>
                      setRuleDraft((prev) => ({ ...prev, pathPattern: event.target.value }))
                    }
                    value={ruleDraft.pathPattern}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rule-status">Response status</Label>
                  <Input
                    id="rule-status"
                    onChange={(event) =>
                      setRuleDraft((prev) => ({ ...prev, responseStatus: event.target.value }))
                    }
                    value={ruleDraft.responseStatus}
                  />
                </div>
                <div className="flex items-end gap-2 py-2">
                  <Switch
                    checked={ruleDraft.enabled}
                    id="rule-enabled"
                    onCheckedChange={(checked) =>
                      setRuleDraft((prev) => ({ ...prev, enabled: Boolean(checked) }))
                    }
                  />
                  <Label htmlFor="rule-enabled">Rule enabled</Label>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="rule-headers">Response headers (JSON)</Label>
                  <Textarea
                    id="rule-headers"
                    onChange={(event) =>
                      setRuleDraft((prev) => ({ ...prev, responseHeadersJson: event.target.value }))
                    }
                    rows={7}
                    value={ruleDraft.responseHeadersJson}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="rule-body">Response body</Label>
                  <Textarea
                    id="rule-body"
                    onChange={(event) =>
                      setRuleDraft((prev) => ({ ...prev, responseBody: event.target.value }))
                    }
                    rows={7}
                    value={ruleDraft.responseBody}
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button disabled={disableActions} onClick={onSaveRule} type="button">
                  {ruleDraft.id ? "Update Rule" : "Add Rule"}
                </Button>
                <Button
                  disabled={disableActions}
                  onClick={onResetRuleDraft}
                  type="button"
                  variant="outline"
                >
                  New Rule
                </Button>
              </div>

              {state?.config.mockRules.length ? (
                <div className="grid gap-2">
                  {state.config.mockRules.map((rule) => (
                    <div
                      className="flex flex-wrap items-center justify-between gap-2 border-b py-2"
                      key={rule.id}
                    >
                      <div className="space-y-1">
                        <p className="text-sm font-medium">{rule.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {rule.method} {rule.hostPattern}
                          {rule.pathPattern}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={rule.enabled ? "default" : "secondary"}>
                          {rule.enabled ? "enabled" : "disabled"}
                        </Badge>
                        <Badge variant="outline">{rule.responseStatus}</Badge>
                        <Button
                          onClick={() => onLoadRule(rule)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Edit
                        </Button>
                        <Button
                          onClick={() => onDeleteRule(rule.id)}
                          size="sm"
                          type="button"
                          variant="destructive"
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No mock rules configured.</p>
              )}
            </section>

            <Separator />

            <section className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3">
                <h2 className="text-lg font-medium">Captured Third-Party Traffic</h2>
                {records.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No requests captured yet.</p>
                ) : (
                  records
                    .slice()
                    .reverse()
                    .map((record) => (
                      <div className="space-y-2 border-b py-2" key={record.id}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-mono text-xs">
                            {record.method} {record.path}
                          </p>
                          <Badge variant="outline">{record.responseStatus}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          host={displayEgressTargetHost(record.headers, record.host)}
                        </p>
                        <div className="grid gap-2 md:grid-cols-2">
                          <div className="space-y-1">
                            <Label>Request</Label>
                            <pre>{prettyBody(record.requestBody)}</pre>
                          </div>
                          <div className="space-y-1">
                            <Label>Response</Label>
                            <pre>{prettyBody(record.responseBody)}</pre>
                          </div>
                        </div>
                      </div>
                    ))
                )}
              </div>

              <div className="space-y-3">
                <h2 className="text-lg font-medium">Runtime Events</h2>
                {events.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No events yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {events
                      .slice()
                      .reverse()
                      .map((event) => (
                        <li className="border-b py-2" key={event.id}>
                          <p className="font-mono text-[11px] text-muted-foreground">
                            {event.createdAt}
                          </p>
                          <p className="text-sm">{event.message}</p>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            </section>
          </>
        ) : isStarting ? (
          <>
            <Separator />
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-primary" />
                <h2 className="text-lg font-medium">Starting Sandbox</h2>
              </div>
              <p className="text-sm text-muted-foreground">
                Waiting for services to become healthy. Startup events stream below.
              </p>
              {hasDeployment ? (
                <dl className="grid grid-cols-[120px_1fr] gap-2 text-sm">
                  <dt className="text-muted-foreground">Container</dt>
                  <dd className="font-mono text-xs break-all">
                    {state?.sandbox.containerName ?? "-"}
                  </dd>
                  <dt className="text-muted-foreground">Ingress</dt>
                  <dd className="font-mono text-xs break-all">
                    {state?.sandbox.ingressUrl ?? "-"}
                  </dd>
                </dl>
              ) : null}
              {recentEvents.length === 0 ? (
                <p className="text-sm text-muted-foreground">No startup logs yet.</p>
              ) : (
                <ul className="space-y-2">
                  {recentEvents.map((event) => (
                    <li className="border-b py-2" key={event.id}>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        {event.createdAt}
                      </p>
                      <p className="text-sm">{event.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : isStopping ? (
          <>
            <Separator />
            <p className="text-sm text-muted-foreground">
              Stopping sandbox and tearing down services.
            </p>
          </>
        ) : (
          <>
            <Separator />
            <p className="text-sm text-muted-foreground">
              Start Sandbox to reveal egress controls, daemon logs, mock rules, traffic captures,
              and runtime events. During startup you&apos;ll see live progress logs here.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
