// Pretty renderers for a processor's reduced state — the panel's drill-in
// view (stream-state-panel.tsx) delegates here. Split out so the panel
// stays the orchestration/overview surface and the per-processor render
// heuristics (which grow one renderer per interesting processor) live in one
// focused module. Everything reads UNKNOWN state defensively: reduced state
// crosses the itx boundary untyped, and a shape miss must degrade to the raw
// code block, never a crash.

import { SerializedObjectCodeBlock } from "@iterate-com/ui/components/serialized-object-code-block";
import { readNumber, readRuntimeRecord } from "~/lib/runtime-record.ts";

export function RuntimeStateStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-muted/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{label}</div>
      <div className="mt-0.5 font-mono text-sm">{value}</div>
    </div>
  );
}

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
      {children}
    </div>
  );
}

export function CorePrettyState({
  state,
  runtime,
}: {
  state: unknown;
  runtime: Record<string, unknown> | undefined;
}) {
  const core = asCoreState(state);
  if (core == null) {
    return <SerializedObjectCodeBlock className="max-h-[28rem]" data={state} />;
  }

  const childPaths = Array.isArray(core.childPaths) ? core.childPaths : [];
  const configured = readRuntimeRecord(core.configuredSubscribersByKey) ?? {};
  const connections = readRuntimeRecord(core.connectionsByKey) ?? {};
  const runtimeSubscriptions = readRuntimeRecord(runtime?.subscriptions) ?? {};
  const paused = core.paused === true;
  const circuitBreaker = readRuntimeRecord(core.circuitBreaker);
  const trippedAtOffset = readNumber(circuitBreaker, "trippedAtOffset");

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <RuntimeStateStat label="head" value={`#${Number(core.maxOffset ?? 0)}`} />
        <RuntimeStateStat label="events" value={String(core.eventCount ?? 0)} />
        <RuntimeStateStat label="children" value={String(childPaths.length)} />
        <RuntimeStateStat label="paused" value={paused ? "yes" : "no"} />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <RuntimeStateStat label="configured" value={String(Object.keys(configured).length)} />
        <RuntimeStateStat label="connected" value={String(Object.keys(connections).length)} />
        <RuntimeStateStat
          label="runtime subs"
          value={String(Object.keys(runtimeSubscriptions).length)}
        />
      </div>

      {core.path == null && core.projectId == null ? null : (
        <div className="rounded-xl bg-muted/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">Stream</div>
          <div className="mt-1 break-all font-mono text-xs">
            {String(core.projectId ?? "global")} {String(core.path ?? "")}
          </div>
          {typeof core.createdAt !== "string" ? null : (
            <div className="mt-1 text-xs text-muted-foreground">{core.createdAt}</div>
          )}
        </div>
      )}

      {paused || trippedAtOffset != null ? (
        <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          {paused ? (
            <div>Paused{typeof core.pauseReason === "string" ? `: ${core.pauseReason}` : ""}</div>
          ) : null}
          {trippedAtOffset == null ? null : (
            <div>Circuit breaker tripped at #{trippedAtOffset}</div>
          )}
        </div>
      ) : null}

      {Object.keys(configured).length === 0 ? null : (
        <div>
          <SectionHeading>Configured subscriptions</SectionHeading>
          <div className="flex flex-col gap-1.5">
            {Object.entries(configured).map(([key, value]) => {
              const latest = readRuntimeRecord(readRuntimeRecord(value)?.latestConfiguredEvent);
              const payload = readRuntimeRecord(latest?.payload);
              const delivery = readRuntimeRecord(payload?.delivery);
              const mode = typeof delivery?.mode === "string" ? delivery.mode : "unknown";
              const runtimeSub = readRuntimeRecord(runtimeSubscriptions[key]);
              const lag = readNumber(runtimeSub, "lag");
              const selector = readRuntimeRecord(payload?.selector);
              const eventTypes = Array.isArray(selector?.eventTypes)
                ? selector.eventTypes.filter((t): t is string => typeof t === "string")
                : [];
              const condition =
                typeof selector?.condition === "string" ? selector.condition : undefined;
              const destination = readAcceptCrossPostPath(delivery?.expression);
              const deliveryHint =
                typeof delivery?.url === "string"
                  ? `POST ${delivery.url}`
                  : destination != null
                    ? `cross-post → ${destination}`
                    : formatItxExpressionHint(delivery?.expression);
              return (
                <div key={key} className="rounded-xl bg-muted/40 px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="min-w-0 break-all font-mono text-xs">{key}</div>
                    <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {mode}
                      {lag == null ? "" : ` · lag ${lag}`}
                    </div>
                  </div>
                  {typeof payload?.description !== "string" ||
                  payload.description.trim() === "" ? null : (
                    <div className="mt-1 text-[11px] leading-snug text-foreground/80">
                      {payload.description.trim()}
                    </div>
                  )}
                  {deliveryHint == null ? null : (
                    <div className="mt-1 break-all font-mono text-[11px] text-foreground/70">
                      {deliveryHint}
                    </div>
                  )}
                  {eventTypes.length === 0 && condition == null ? null : (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {/* `*` anywhere means "all types" — same convention as EventSelector. */}
                      {eventTypes.length === 0 || eventTypes.includes("*")
                        ? "all events"
                        : eventTypes
                            .map((type) => type.replace("events.iterate.com/", ""))
                            .join(", ")}
                      {condition == null
                        ? ""
                        : ` when ${condition.length > 48 ? `${condition.slice(0, 45)}…` : condition}`}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {childPaths.length === 0 ? null : (
        <div>
          <SectionHeading>Child streams</SectionHeading>
          <div className="flex flex-col gap-1.5">
            {childPaths.slice(0, 8).map((path) => (
              <div
                key={String(path)}
                className="rounded-xl bg-muted/40 px-3 py-2 font-mono text-xs"
              >
                {String(path)}
              </div>
            ))}
          </div>
          {childPaths.length <= 8 ? null : (
            <div className="mt-1 text-xs text-muted-foreground">+{childPaths.length - 8} more</div>
          )}
        </div>
      )}
    </div>
  );
}

function asCoreState(state: unknown): Record<string, unknown> | null {
  if (state == null || typeof state !== "object") return null;
  const record = state as Record<string, unknown>;
  if (
    !("maxOffset" in record) &&
    !("configuredSubscribersByKey" in record) &&
    !("connectionsByKey" in record)
  ) {
    return null;
  }
  return record;
}

/** Pretty renderer for the agent processor reduced state (status machine). */
export function AgentPrettyState({ state }: { state: unknown }) {
  const agent = asAgentState(state);
  if (agent == null) {
    return <SerializedObjectCodeBlock className="max-h-[28rem]" data={state} />;
  }

  const openRequest =
    agent.openRequest != null && typeof agent.openRequest === "object"
      ? (agent.openRequest as Record<string, unknown>)
      : null;
  const paused =
    agent.paused != null && typeof agent.paused === "object"
      ? (agent.paused as Record<string, unknown>)
      : null;
  const phase = paused != null ? "paused" : openRequest == null ? "idle" : "requested";
  const config = readRuntimeRecord(agent.config);
  const llm = readRuntimeRecord(config?.llm);
  const contextItems = Array.isArray(agent.contextItems) ? agent.contextItems : [];
  const isSystem = (item: unknown) => readItemPayload(item)?.role === "system";
  const system = contextItems.filter(isSystem);
  const history = contextItems.filter((item) => !isSystem(item));
  const lastMessage = history.length > 0 ? history[history.length - 1] : null;
  const lastPreview = lastMessage == null ? null : previewProjectedItem(lastMessage);
  const scripts = Array.isArray(agent.activeScriptExecutionIds)
    ? agent.activeScriptExecutionIds
    : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <RuntimeStateStat label="phase" value={phase} />
        <RuntimeStateStat label="published" value={`#${String(agent.lastLlmRequestOffset ?? 0)}`} />
        <RuntimeStateStat label="model" value={String(llm?.model ?? "—")} />
        <RuntimeStateStat label="failures" value={String(agent.consecutiveLlmFailures ?? 0)} />
      </div>

      {openRequest == null ? null : (
        <div className="rounded-xl bg-muted/40 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
            Open request
          </div>
          <div className="mt-1 font-mono text-xs break-all">{JSON.stringify(openRequest)}</div>
        </div>
      )}

      {paused == null ? null : (
        <div className="rounded-xl bg-amber-500/10 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-amber-700/80 dark:text-amber-300/80">
            Paused
          </div>
          <div className="mt-1 text-xs text-foreground/80">
            {typeof paused.reason === "string" ? paused.reason : "Scheduling paused."}
          </div>
        </div>
      )}

      {scripts.length === 0 ? null : (
        <div>
          <SectionHeading>In-progress scripts</SectionHeading>
          <div className="flex flex-col gap-1.5">
            {scripts.map((executionId, index) => (
              <div
                key={String(executionId ?? index)}
                className="rounded-xl bg-muted/40 px-3 py-2 font-mono text-xs"
              >
                {String(executionId ?? "script")}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl bg-muted/40 px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
            History
          </div>
          <div className="font-mono text-xs text-muted-foreground">{history.length} items</div>
        </div>
        {lastPreview == null ? (
          <div className="mt-1 text-xs text-muted-foreground">No messages yet.</div>
        ) : (
          <div className="mt-1 text-xs text-foreground/80">
            <span className="font-medium text-muted-foreground">{lastPreview.role}: </span>
            {lastPreview.text}
          </div>
        )}
        <div className="mt-1 text-[10px] text-muted-foreground/70">
          Full projected history is in Raw view (and in the Pretty feed).
        </div>
      </div>

      {system.length === 0 ? null : (
        <details className="rounded-xl bg-muted/40 px-3 py-2">
          <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground/70">
            System context ({system.length})
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-foreground/80">
            {system.map(renderProjectedContextItem).join("\n\n")}
          </pre>
        </details>
      )}

      <div className="grid grid-cols-2 gap-2">
        <RuntimeStateStat label="autonomous turns" value={String(agent.autonomousTurnCount ?? 0)} />
        <RuntimeStateStat label="pending scripts" value={String(scripts.length)} />
      </div>
    </div>
  );
}

function asAgentState(state: unknown): Record<string, unknown> | null {
  if (state == null || typeof state !== "object") return null;
  const record = state as Record<string, unknown>;
  // Agent state is recognized by its provider-neutral context projection
  // (`contextItems`) plus its config.
  if (!("contextItems" in record) || !("config" in record)) {
    return null;
  }
  return record;
}

/** A projected context item is `{ offset, payload }`; the model-visible fields
 * (role, content, key) live on the payload. */
function readItemPayload(item: unknown): Record<string, unknown> | null {
  if (item == null || typeof item !== "object") return null;
  const payload = (item as Record<string, unknown>).payload;
  return payload != null && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : null;
}

function renderProjectedContextItem(item: unknown): string {
  if (item == null || typeof item !== "object") return String(item);
  const record = item as Record<string, unknown>;
  const payload = readItemPayload(item) ?? {};
  const fields = [
    typeof record.offset === "number" ? `@${record.offset}` : "@?",
    typeof payload.key === "string" ? `key=${JSON.stringify(payload.key)}` : null,
    typeof record.updatesOffset === "number" ? `updates=@${record.updatesOffset}` : null,
    typeof payload.role === "string" ? `role=${payload.role}` : null,
  ].filter((field): field is string => field !== null);
  return `${fields.join(" ")}\n${String(payload.content ?? "")}`;
}

function previewProjectedItem(item: unknown): { role: string; text: string } | null {
  const payload = readItemPayload(item);
  return payload == null ? null : previewChatMessage(payload);
}

function previewChatMessage(message: Record<string, unknown>): { role: string; text: string } {
  const role = String(message.role ?? message.kind ?? "message");
  const content = message.content ?? message.text ?? message;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part != null && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  } else text = JSON.stringify(content);
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > 160) text = `${text.slice(0, 157)}…`;
  return { role, text: text || "(empty)" };
}

/** `["streams", ["get", path], "acceptCrossPost"]` → path. */
function readAcceptCrossPostPath(expression: unknown): string | null {
  if (!Array.isArray(expression) || expression.length < 3) return null;
  if (expression[0] !== "streams") return null;
  if (expression[expression.length - 1] !== "acceptCrossPost") return null;
  const getStep = expression[1];
  if (!Array.isArray(getStep) || getStep[0] !== "get") return null;
  return typeof getStep[1] === "string" ? getStep[1] : null;
}

/** Compact itx expression for core-state list rows. */
function formatItxExpressionHint(expression: unknown): string | null {
  if (!Array.isArray(expression) || expression.length === 0) return null;
  const steps: string[] = [];
  for (const step of expression) {
    if (typeof step === "string") {
      steps.push(step);
    } else if (Array.isArray(step) && typeof step[0] === "string") {
      const args = step
        .slice(1)
        .map((arg) => {
          try {
            return JSON.stringify(arg);
          } catch {
            return "…";
          }
        })
        .join(", ");
      steps.push(`${step[0]}(${args})`);
    } else {
      return null;
    }
  }
  const call = steps.join(".");
  return `itx.${call.endsWith(")") ? call : `${call}()`}`;
}
