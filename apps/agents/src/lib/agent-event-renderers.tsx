// How the Events tab reads an agent's log: one sentence per event type the agent loop records
// (apps/agents/runtime/contract.ts) — the context view's renderer registry for this app. The
// platform's own events (born, woke, script runs) come with the view; anything else falls back to
// the view's default row.
import type {
  EventInspectors,
  EventRenderers,
} from "@iterate-com/ui/components/context-view/types";
import { mono, record, str } from "@iterate-com/ui/components/context-view/renderer-helpers";

const num = (value: unknown) => (typeof value === "number" ? String(value) : "?");
/** The first line of a text, cut for a row. */
const firstLine = (text: string, max = 160) => {
  const line = text.split("\n")[0] || "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The role a context item was added as — the model's conversation has four. */
const role = (name: string) => (
  <>
    <span className="rounded bg-muted px-1 font-mono text-[10px] uppercase text-muted-foreground">
      {name}
    </span>{" "}
  </>
);

/** Prose as the model saw or said it, whole, wrapped — never a sideways scroll. */
const prose = (text: string) => <p className="text-sm whitespace-pre-wrap break-words">{text}</p>;

/** The inspector's rich bodies: the words themselves, whole. */
export const agentEventInspectors: EventInspectors = {
  "events.iterate.com/agent/context-added": (e) => {
    const p = record(e.payload);
    return (
      <div className="flex flex-col gap-2">
        <div>{role(str(p.role, "?"))}</div>
        {prose(str(p.content))}
      </div>
    );
  },
  "events.iterate.com/agent/web-message-sent": (e) => prose(str(record(e.payload).message)),
  "events.iterate.com/agent/llm-request-settled": (e) => {
    const result = record(record(e.payload).result);
    if (result.status === "succeeded") return prose(str(result.text));
    if (result.status === "failed")
      return (
        <div className="flex flex-col gap-2">
          <p data-type="error" className="text-sm text-destructive">
            {str(result.errorMessage)}
          </p>
          {result.partialText ? prose(str(result.partialText)) : null}
        </div>
      );
    return result.partialText ? prose(str(result.partialText)) : null;
  },
};

export const agentEventRenderers: EventRenderers = {
  "events.iterate.com/agent/create-requested": () => <>Someone asked for this agent</>,
  "events.iterate.com/agent/created": (e) => (
    <>The agent was born at {mono(str(record(e.payload).path))}</>
  ),
  "events.iterate.com/agent/create-failed": (e) => (
    <>Creating the agent failed: {firstLine(str(record(e.payload).error, "unknown error"))}</>
  ),
  "events.iterate.com/agent/delete-requested": () => <>Someone asked to delete this agent</>,
  "events.iterate.com/agent/deleted": () => <>The agent was deleted</>,
  "events.iterate.com/agent/configured": (e) => {
    const config = record(record(e.payload).config);
    const llm = record(config.llm);
    const knobs = [
      typeof llm.model === "string" ? `model ${llm.model}` : "",
      config.maxAutonomousTurns === undefined
        ? ""
        : `max autonomous turns ${num(config.maxAutonomousTurns)}`,
    ].filter(Boolean);
    return <>Configured{knobs.length > 0 ? <>: {mono(knobs.join(" · "))}</> : null}</>;
  },
  "events.iterate.com/agent/context-added": (e) => {
    const p = record(e.payload);
    return (
      <>
        {role(str(p.role, "?"))}
        {firstLine(str(p.content))}
      </>
    );
  },
  "events.iterate.com/agent/web-message-sent": (e) => (
    <>
      {role("said")}
      {firstLine(str(record(e.payload).message))}
    </>
  ),
  "events.iterate.com/agent/summary-updated": (e) => (
    <>
      Status: <strong>{firstLine(str(record(e.payload).activity))}</strong>
    </>
  ),
  "events.iterate.com/agent/llm-request-requested": (e) => {
    const p = record(e.payload);
    return (
      <>
        Asked {mono(str(p.model))} to answer {mono(`#${num(p.triggerOffset)}`)}
      </>
    );
  },
  "events.iterate.com/agent/llm-response-frame": (e) => {
    const p = record(e.payload);
    const chunks = Array.isArray(p.chunks) ? p.chunks.length : 0;
    return (
      <span className="text-muted-foreground">
        Streaming {String(chunks)} chunk{chunks === 1 ? "" : "s"} for{" "}
        {mono(`#${num(p.llmRequestOffset)}`)}
      </span>
    );
  },
  "events.iterate.com/agent/llm-request-settled": (e) => {
    const p = record(e.payload);
    const result = record(p.result);
    const request = mono(`#${num(p.requestOffset)}`);
    const took = p.durationMs === undefined ? "" : ` in ${num(p.durationMs)} ms`;
    if (result.status === "succeeded")
      return (
        <>
          The model answered {request}
          {took}: {firstLine(str(result.text))}
        </>
      );
    if (result.status === "failed")
      return (
        <>
          The model failed {request}
          {took}: {firstLine(str(result.errorMessage))}
        </>
      );
    return (
      <>
        Request {request} cancelled ({str(result.reason, "?")}){took}
      </>
    );
  },
  "events.iterate.com/agent/token-usage-reported": (e) => {
    const p = record(e.payload);
    return (
      <span className="text-muted-foreground">
        {num(p.inputTokens)} of {num(p.maxContextTokens)} context tokens used ({str(p.model)})
      </span>
    );
  },
  "events.iterate.com/agent/paused": (e) => {
    const p = record(e.payload);
    return (
      <>
        Paused: {str(p.reason)}
        {p.triggerOffset === undefined ? null : <> (trigger {mono(`#${num(p.triggerOffset)}`)})</>}
      </>
    );
  },
  "events.iterate.com/agent/resumed": (e) => {
    const reason = str(record(e.payload).reason);
    return <>Resumed{reason ? `: ${reason}` : ""}</>;
  },
};
