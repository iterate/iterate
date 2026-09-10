import { useMemo, useState } from "react";
import type {
  AgentUiCodeStep,
  AgentUiLlmStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { MessageResponse } from "@iterate-com/ui/components/ai-elements/message";
import { Button } from "@iterate-com/ui/components/button";
import { buildRoundMetaYaml } from "@iterate-com/ui/components/agent-feed/agent-round-meta-yaml";
import {
  MetaYamlBlock,
  RawRoundResult,
} from "@iterate-com/ui/components/agent-feed/agent-activity-rounds";
import { useStreamQuery } from "~/domains/streams/client-libraries/browser/hooks/use-stream-query.ts";
import type { StreamBrowserDatabase } from "~/domains/streams/client-libraries/browser/stream-browser-db.ts";
import { LLM_REPLAY_EVENT_TYPES, replayLlmRequest } from "~/lib/llm-request-replay.ts";
import { stringifyScriptResult } from "~/lib/script-result-render.ts";

// The OS half of a feed round's tabs: the pieces that read the raw-event
// mirror (StreamBrowserDatabase). The shared rounds
// (@iterate-com/ui/components/agent-feed/agent-activity-rounds) take these as
// `roundResult` / `roundMeta` render props; without them they show the raw
// result and the stats-only Meta YAML.

/** The canonical model-visible context event; script-actor instances carry the
 * settlement text `renderScriptSettlement` produced for the agent. */
const SCRIPT_RENDER_EVENT_TYPE = "events.iterate.com/agents/context-added";

/**
 * The Result tab body when the raw-event mirror is available: the agent's
 * view — the exact settlement text `renderScriptSettlement` appended for the
 * model — is one toggle away, and becomes the DEFAULT precisely when that
 * text is a transformed representation (inline truncation at the history
 * limit, or an oversized result replaced by an inferred type + bounded
 * preview + loader recipe): in that case the raw view would misrepresent
 * what the agent could actually see. When the agent saw the full result, the
 * raw view is strictly nicer to read and stays the default.
 *
 * The agent-visible settlement render lives ON THE STREAM: a developer
 * `agents/context-added` event stamped `actor: {type: "script", executionId}`
 * — queried from the mirror the same way the Meta tab replays its prompt
 * (only while this tab is mounted; inactive base-ui tab panels unmount). The
 * query is live, so a render event that lands moments after the settlement
 * fills in when it arrives; streams with no render event (predating the
 * server-side render, or non-agent executions) keep the raw view.
 */
export function AgentRenderedRoundResult({
  code,
  database,
}: {
  code: AgentUiCodeStep;
  database: StreamBrowserDatabase;
}) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const eventsResult = useStreamQuery(
    database,
    `SELECT json(raw_jsonb) AS raw_json FROM events
     WHERE type = ?
       AND json_extract(raw_jsonb, '$.payload.actor.type') = 'script'
       AND json_extract(raw_jsonb, '$.payload.actor.executionId') = ?
     ORDER BY offset ASC
     LIMIT 1`,
    [SCRIPT_RENDER_EVENT_TYPE, code.executionId],
  );
  const agentText = useMemo(() => {
    const row = eventsResult.data[0];
    if (eventsResult.status !== "ok" || row == null) return null;
    try {
      // raw_json is the mirrored context-added event verbatim; the assertion
      // only names the two optional fields read below, and `content` is
      // still type-checked at runtime before use.
      const parsed = JSON.parse(String(row.raw_json)) as { payload?: { content?: unknown } };
      const content = parsed.payload?.content;
      return typeof content === "string" ? content : null;
    } catch {
      return null;
    }
  }, [eventsResult.status, eventsResult.data]);
  // Wait for the local mirror (it answers in ms) instead of painting the raw
  // view and swapping it out from under the reader.
  if (eventsResult.status === "pending") return null;
  if (agentText == null) return <RawRoundResult code={code} />;
  const showRaw = toggled ?? !renderIsTransformed(code, agentText);
  return (
    <>
      {showRaw ? (
        <RawRoundResult code={code} />
      ) : (
        <div
          className="max-h-80 overflow-y-auto rounded-lg bg-muted/20 px-3 py-2 text-sm"
          data-testid="script-result-agent-view"
        >
          {/* Same settled-markdown path as assistant messages: static mode,
              no unpaired-marker balancing (see agent-feed-item.tsx). */}
          <MessageResponse
            className="min-w-0 max-w-full overflow-hidden"
            mode="static"
            parseIncompleteMarkdown={false}
          >
            {agentText}
          </MessageResponse>
        </div>
      )}
      <Button
        variant="ghost"
        size="xs"
        data-testid="script-result-view-toggle"
        onClick={() => setToggled(!showRaw)}
        className="-ml-2 self-start font-normal text-muted-foreground"
      >
        {showRaw ? "Show agent view" : "Show raw result"}
      </Button>
    </>
  );
}

/**
 * Did the agent see a TRANSFORMED representation of this settlement, rather
 * than the full thing? Detected structurally: the untransformed render
 * (`renderScriptSettlement` in
 * apps/os/src/domains/agents/agent-processor-implementation.ts) embeds the
 * exact stringified settlement verbatim inside its fence — computed by the
 * SAME `stringifyScriptResult` this check imports (lib/script-result-render),
 * so the coupling is enforced by sharing the implementation, not by
 * convention — while every transforming path (inline truncation at the
 * history limit, oversized spills replaced by an inferred type + elided
 * preview) necessarily drops part of it. So a containment check
 * distinguishes the cases without matching on notice strings. Fail-safe
 * either way: if containment breaks for any other reason, the tab defaults
 * to the agent view — which never misrepresents — rather than to a raw view
 * claiming the agent saw everything.
 */
function renderIsTransformed(code: AgentUiCodeStep, agentText: string): boolean {
  const full =
    code.result !== undefined ? stringifyScriptResult(code.result) : (code.errorMessage ?? null);
  if (full == null) return true;
  return !agentText.includes(full);
}

/**
 * The Meta tab body when the raw-event mirror is available: the round's stats
 * YAML plus its replayed prompt (queried only while this tab is mounted —
 * inactive base-ui tab panels unmount).
 */
export function RoundMetaWithPrompt({
  llm,
  code,
  database,
}: {
  llm: AgentUiLlmStep;
  code: AgentUiCodeStep;
  database: StreamBrowserDatabase;
}) {
  // Prompt construction folds purely from events at or before the request
  // offset — immutable history (the same fold as the ?llmRequest trace sheet,
  // minus the request-scoped lifecycle events that only feed the response
  // side, which this tab doesn't show).
  const eventsResult = useStreamQuery(
    database,
    `SELECT json(raw_jsonb) AS raw_json FROM events
     WHERE type IN (${LLM_REPLAY_EVENT_TYPES.map(() => "?").join(", ")})
       AND offset <= ?
     ORDER BY offset ASC`,
    [...LLM_REPLAY_EVENT_TYPES, llm.llmRequestOffset],
  );
  const loaded = eventsResult.status === "ok";
  const yamlText = useMemo(() => {
    const replay = loaded
      ? replayLlmRequest({
          rawEventJsons: eventsResult.data.map((sqlRow) => String(sqlRow.raw_json)),
          llmRequestOffset: llm.llmRequestOffset,
        })
      : null;
    return buildRoundMetaYaml(
      llm,
      code,
      replay === null ? null : { messages: replay.messages, reconstructed: replay.reconstructed },
    );
  }, [loaded, eventsResult.data, llm, code]);
  return <MetaYamlBlock yamlText={yamlText} />;
}
