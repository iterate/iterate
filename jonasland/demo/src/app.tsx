import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { Input } from "@iterate-com/ui/components/input";
import { Label } from "@iterate-com/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import { Separator } from "@iterate-com/ui/components/separator";
import { Switch } from "@iterate-com/ui/components/switch";
import { Textarea } from "@iterate-com/ui/components/textarea";
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

  const records = state?.records ?? [];
  const events = state?.events ?? [];

  const phase = useMemo(() => state?.phase ?? "idle", [state?.phase]);

  return (
    <div className="min-h-screen bg-muted/40">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 md:p-6">
        <Card>
          <CardHeader className="gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle>Mock Demo OS</CardTitle>
                <CardDescription>
                  Create a deployment, poke it from outside, and use this server as its external
                  egress proxy with controllable scenarios.
                </CardDescription>
              </div>
              <Badge variant={phaseBadgeVariant(phase)}>{phaseLabel(phase)}</Badge>
            </div>
            {errorText ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {errorText}
              </p>
            ) : null}
          </CardHeader>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Deployment Controls</CardTitle>
              <CardDescription>Provider, sandbox lifecycle, and entry links.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
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
                  onClick={() => void refresh({ syncDrafts: true })}
                  type="button"
                  variant="outline"
                >
                  Refresh
                </Button>
              </div>

              <Separator />

              <dl className="grid grid-cols-[120px_1fr] gap-2 text-sm">
                <dt className="text-muted-foreground">Container</dt>
                <dd className="font-mono text-xs break-all">
                  {state?.sandbox.containerName ?? "-"}
                </dd>
                <dt className="text-muted-foreground">Ingress</dt>
                <dd className="font-mono text-xs break-all">{state?.sandbox.ingressUrl ?? "-"}</dd>
                <dt className="text-muted-foreground">Home</dt>
                <dd className="font-mono text-xs break-all">
                  {state?.links.home ? (
                    <a
                      className="underline"
                      href={state.links.home}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {state.links.home}
                    </a>
                  ) : (
                    "-"
                  )}
                </dd>
                <dt className="text-muted-foreground">Egress Proxy</dt>
                <dd className="font-mono text-xs break-all">
                  {state?.sandbox.externalEgressProxy ?? "-"}
                </dd>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Egress Scenario</CardTitle>
              <CardDescription>Default behavior when no mock rule matches.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
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
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Mock Rules</CardTitle>
            <CardDescription>
              Rules match outbound method/host/path (`*` wildcard) before fallback mode is applied.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
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
                    setRuleDraft((prev) => ({ ...prev, method: event.target.value.toUpperCase() }))
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
              <div className="flex items-end gap-2 rounded-md border p-3">
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

            <div className="grid gap-4 md:grid-cols-2">
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

            <Separator />

            {state?.config.mockRules.length ? (
              <div className="grid gap-2">
                {state.config.mockRules.map((rule) => (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
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
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>Egress Firehose</CardTitle>
                <CardDescription>
                  All outbound requests and responses captured by this host.
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={autoRefresh}
                  id="auto-refresh"
                  onCheckedChange={(checked) => setAutoRefresh(Boolean(checked))}
                />
                <Label htmlFor="auto-refresh">Auto refresh</Label>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {records.length === 0 ? (
                <p className="text-sm text-muted-foreground">No requests captured yet.</p>
              ) : (
                records
                  .slice()
                  .reverse()
                  .map((record) => (
                    <div className="space-y-2 rounded-md border p-3" key={record.id}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-mono text-xs">
                          {record.method} {record.path}
                        </p>
                        <Badge variant="outline">{record.responseStatus}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">host={record.host}</p>
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Runtime Events</CardTitle>
              <CardDescription>Server-side operation log from the mock demo OS.</CardDescription>
            </CardHeader>
            <CardContent>
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No events yet.</p>
              ) : (
                <ul className="space-y-2">
                  {events
                    .slice()
                    .reverse()
                    .map((event) => (
                      <li className="rounded-md border p-2" key={event.id}>
                        <p className="font-mono text-[11px] text-muted-foreground">
                          {event.createdAt}
                        </p>
                        <p className="text-sm">{event.message}</p>
                      </li>
                    ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
