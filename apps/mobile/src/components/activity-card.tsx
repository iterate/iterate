// One activity roll-up in the chat feed — the mobile rendering of the web's
// "Ran code 2× · 3 requests · 7.4s" rows (packages/ui agent-ui-reducer items).
// Collapsed (the default, live or settled): the one-line summary plus status
// glyphs (spinner while running, approval marks once the run parked batches
// at the egress door). Expanded (tap only): the run organized into
// ROUNDS — the llm step that writes a script and the code step that runs it.
// A single round shows its content directly; several rounds each collapse to
// an "N · <summary status>" header (tap to expand; a running round
// streams open) — where each code step is a tabbed view: Script | Approvals
// | Result | Meta. The Approvals tab renders the SAME shared
// ApprovalBatchBody the
// Notifications expansion uses, so the in-context view can never drift from
// the archive; Meta holds the step stat lines (model, duration, tokens) that
// used to sit above the tab bar.

import { useId, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Document, Scalar, visit } from "yaml";
import type { StreamEvent } from "iterate/sdk/itx/react";
import { looksLikeCode } from "../lib/activity-display.ts";
import {
  deriveBatchesForExecution,
  summarizeBatchOutcomes,
  type RequestedPayload,
  type ResolvedBatch,
} from "../lib/approvals.ts";
import type {
  AgentUiActivity,
  AgentUiCodeStep,
  AgentUiLiveStatus,
  AgentUiLlmStep,
  AgentUiStep,
} from "../lib/feed.ts";
import { groupActivityRounds, summarizeActivity } from "../lib/feed.ts";
import { colors, radius, spacing } from "../lib/theme.ts";
import {
  LLM_REPLAY_EVENT_TYPES,
  replayLlmRequest,
} from "../../../os/src/lib/llm-request-replay.ts";
import { ApprovalBatchBody } from "./approval-batch.tsx";
import CodeEditor from "./code-editor.tsx";

/** What the card needs to find and render its run's approval batches: the
 * chat screen's live root-stream approval events plus routing context. */
export type ActivityApprovalContext = {
  baseUrl: string;
  events: StreamEvent[];
  projectId: string;
  projectSlug: string;
};

export function ActivityCard({
  activity,
  approvals,
  liveStatus,
  threadEvents,
}: {
  activity: AgentUiActivity;
  approvals: ActivityApprovalContext;
  /** The feed's live-status derivation, when THIS card is the live activity
   * (null for settled cards): the phase drives the glyph next to the
   * spinner, and an agent-set status from this turn replaces the generic
   * "writing code…"/"running code…" text. */
  liveStatus: AgentUiLiveStatus | null;
  /** The thread's own event window — the Meta tab replays each llm request's
   * exact prompt from it (same pure fold as the os trace panel). */
  threadEvents: StreamEvent[];
}) {
  const isLive = activity.status !== "done";
  const [toggled, setToggled] = useState<boolean | null>(null);
  // Collapsed by default, live or not: a streaming run used to auto-expand
  // and balloon the chat as code filled in, then vanish back to one line on
  // settle. The summary row already tells the live story small — spinner
  // plus "writing code…" — so expansion is a deliberate tap, both ways.
  // (Inside an opened card, a RUNNING round still streams open — that
  // auto-expand is what the tap asked to watch.)
  const expanded = toggled === true;
  const rounds = groupActivityRounds(activity.steps);
  const batchesByExecution = new Map(
    activity.steps
      .filter((step): step is AgentUiCodeStep => step.kind === "code")
      .map((step) => [
        step.executionId,
        deriveBatchesForExecution(approvals.events, step.executionId, Date.now()),
      ]),
  );
  const outcomes = summarizeBatchOutcomes([...batchesByExecution.values()].flat());

  return (
    <View style={[styles.card, isLive && styles.cardLive]} testID={`activity-card-${activity.id}`}>
      <Pressable style={styles.summaryRow} onPress={() => setToggled(!expanded)}>
        {isLive && activity.status === "running" ? (
          <ActivityIndicator accessibilityLabel="Loading" size="small" color={colors.working} />
        ) : (
          <Text style={styles.chevron}>{expanded ? "▾" : "▸"}</Text>
        )}
        {isLive ? <PhaseGlyph phase={liveStatus?.phase} /> : null}
        <Text style={styles.summary} numberOfLines={1}>
          {isLive ? liveSummary(activity, liveStatus) : summarizeActivity(activity)}
        </Text>
        <ApprovalGlyphs outcomes={outcomes} />
      </Pressable>
      {expanded
        ? rounds.map((round, index) => (
            <RoundView
              key={round.code?.id || round.llm?.id || index}
              approvals={approvals}
              batches={round.code ? batchesByExecution.get(round.code.executionId) || [] : []}
              collapsible={rounds.length > 1}
              index={index}
              round={round}
              threadEvents={threadEvents}
            />
          ))
        : null}
    </View>
  );
}

/**
 * One round of the expanded card. A single round renders its content
 * directly; several rounds each collapse to an "N · <status> ·
 * <duration>" header row so the per-round summary statuses read as a list —
 * the os feed's AgentActivityRoundRow shape
 * (apps/os/src/components/agent-activity-rounds.tsx). A round whose code
 * step is still running expands automatically so the live run stays
 * watchable.
 */
function RoundView({
  approvals,
  batches,
  collapsible,
  index,
  round,
  threadEvents,
}: {
  approvals: ActivityApprovalContext;
  batches: {
    offset: number;
    payload: RequestedPayload;
    resolved: ResolvedBatch | null;
    expired: boolean;
  }[];
  collapsible: boolean;
  index: number;
  round: { llm: AgentUiLlmStep | null; code: AgentUiCodeStep | null };
  threadEvents: StreamEvent[];
}) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = !collapsible || (toggled ?? round.code?.status === "running");
  return (
    <View style={styles.step}>
      {collapsible ? (
        <Pressable style={styles.roundHeader} onPress={() => setToggled(!expanded)}>
          <Text style={styles.chevron}>{expanded ? "▾" : "▸"}</Text>
          <Text style={styles.roundLabel}>{index + 1}</Text>
          {/* The agent's summary status as of this round (the reducer stamps
              the latest agent/summary-updated fold onto each code step).
              Summaries aren't forced short — one line, ellipsized. */}
          {roundHeaderMeta(round) === "" ? null : (
            <Text numberOfLines={1} style={styles.roundMeta}>
              {roundHeaderMeta(round)}
            </Text>
          )}
        </Pressable>
      ) : null}
      {expanded ? (
        <>
          {round.llm ? <LlmStepView code={round.code} step={round.llm} /> : null}
          {round.code ? (
            <CodeStepTabs
              approvals={approvals}
              batches={batches}
              llm={round.llm}
              step={round.code}
              threadEvents={threadEvents}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

/**
 * The collapsed card's approval marks: ◷ while any batch awaits its human
 * (and is still decidable — an expired-undecided batch already counts as ✗,
 * where the door's expiry decision will land it), ✓ when a batch was fully
 * approved, ✗ when one was rejected or mixed — so "did that run get its
 * approvals?" reads without expanding anything. No batches, no glyphs.
 */
function ApprovalGlyphs({
  outcomes,
}: {
  outcomes: { open: number; approved: number; rejected: number; mixed: number };
}) {
  const glyphs = [
    ...(outcomes.open > 0
      ? [{ mark: "◷", style: styles.glyphOpen, label: "approval pending" }]
      : []),
    ...(outcomes.approved > 0
      ? [{ mark: "✓", style: styles.glyphApproved, label: "approved" }]
      : []),
    ...(outcomes.rejected + outcomes.mixed > 0
      ? [{ mark: "✗", style: styles.glyphRejected, label: "rejected" }]
      : []),
  ];
  if (glyphs.length === 0) return null;
  return (
    <View style={styles.glyphRow}>
      {glyphs.map((glyph) => (
        <Text accessibilityLabel={glyph.label} key={glyph.mark} style={[styles.glyph, glyph.style]}>
          {glyph.mark}
        </Text>
      ))}
    </View>
  );
}

/**
 * The round header's muted suffix: the agent's summary `activity` as of the
 * round plus its code duration — "Searching the five most recent FirstFT
 * emails · 0.2s". Same idea as the os web feed's roundHeaderMeta
 * (apps/os/src/components/agent-activity-rounds.tsx); with no summary the
 * header stays bare (the Meta tab carries the stats).
 */
function roundHeaderMeta(round: { llm: AgentUiLlmStep | null; code: AgentUiCodeStep | null }) {
  const { code, llm } = round;
  if (code == null) {
    // An llm-only round (cancelled, failed, or its code half never arrived):
    // now that collapsed rounds hide LlmStepView's stat line, the header
    // carries the outcome — same vocabulary as footerStats.
    if (llm == null) return "";
    return [
      ...(llm.cancelReason === "interrupted-by-user-input"
        ? ["stopped for your new message"]
        : llm.cancelReason === "expired"
          ? ["expired"]
          : llm.outcome === "cancelled"
            ? ["cancelled"]
            : llm.outcome === "failed"
              ? ["failed"]
              : []),
      ...(llm.durationMs == null ? [] : [`${(llm.durationMs / 1000).toFixed(1)}s`]),
    ].join(" · ");
  }
  return [
    ...(code.activitySummary ? [code.activitySummary] : []),
    ...(code.durationMs == null ? [] : [`${(code.durationMs / 1000).toFixed(1)}s`]),
  ].join(" · ");
}

/**
 * The collapsed live card's second mark, after the spinner: what KIND of
 * waiting this is. Text glyphs like ApprovalGlyphs, not vector icons — the
 * summary row already speaks that language. Phases with nothing stronger to
 * say than "working" (queued, waiting, thinking) show no glyph.
 */
function PhaseGlyph({ phase }: { phase: AgentUiLiveStatus["phase"] | undefined }) {
  const glyph =
    phase === "writing"
      ? { mark: "✎", label: "writing code" }
      : phase === "running"
        ? { mark: "▶", label: "running code" }
        : phase === "processing"
          ? { mark: "↻", label: "processing result" }
          : null;
  if (glyph === null) return null;
  return (
    <Text accessibilityLabel={glyph.label} style={styles.phaseGlyph} testID="live-phase-glyph">
      {glyph.mark}
    </Text>
  );
}

function liveSummary(activity: AgentUiActivity, liveStatus: AgentUiLiveStatus | null): string {
  // An agent-set status from this turn beats the generic phase text —
  // whether it came from the running script's first line or an earlier
  // round of the same turn.
  if (liveStatus?.statusText) return liveStatus.statusText;
  const phase = liveStatus?.phase;
  if (phase === "running") return "running code…";
  if (phase === "writing") return "writing code…";
  if (phase === "thinking") return "thinking…";
  if (phase === "waiting") return "waiting for a response…";
  if (phase === "processing") return "working…";
  // No feed-level status (a caller without the live derivation): the old
  // steps-only fallback keeps the card honest.
  const current = activity.steps.findLast((step) => step.status === "running");
  if (current?.kind === "code") return "running code…";
  if (current?.kind === "llm" && current.responseText !== "") return "writing code…";
  if (current?.kind === "llm" && current.thinkingText !== "") return "thinking…";
  if (current?.kind === "llm") return "waiting for a response…";
  return "working…";
}

function LlmStepView({ code, step }: { code: AgentUiCodeStep | null; step: AgentUiLlmStep }) {
  // Once the round has a code step, the raw response is REDUNDANT here: the
  // extracted script sits in the Script tab, extracted prose in the chat
  // bubbles, and the verbatim text in Meta → response. It renders only for
  // code-less moments — the live stream before a script lands, or a round
  // whose code half never arrived.
  const responseText = code === null ? step.responseText : "";
  return (
    <View style={styles.stepBody}>
      {/* Once the round has a code step, this stat line lives in its Meta
          tab instead; with no code step there is no tab bar, so it renders
          here (streaming llm, or a round whose code half never arrived). */}
      {code === null ? (
        <Text style={styles.stepLabel}>
          {`llm${step.model ? ` · ${step.model}` : ""}${footerStats(step)}`}
        </Text>
      ) : null}
      {step.thinkingText !== "" ? (
        <Text style={styles.thinking}>{tail(step.thinkingText, 600)}</Text>
      ) : null}
      {responseText === "" ? null : step.interpreted && !looksLikeCode(responseText) ? (
        // An interpreted prose response (a userland format extracted the real
        // reply into a chat bubble): source material, not code — muted text,
        // parity with the os feed's LlmOnlyRound.
        <Text style={styles.thinking}>{responseText}</Text>
      ) : (
        <CodeBlock language="typescript" muted={step.interpreted === true} text={responseText} />
      )}
      {step.errorMessage ? <Text style={styles.error}>{step.errorMessage}</Text> : null}
    </View>
  );
}

/**
 * One code step as tabs. Script is always there; Approvals only when the
 * run parked batches at the egress door (rendered through the shared
 * ApprovalBatchBody — the same component the Notifications expansion uses,
 * so the two can't drift); Result only once the run settled with a value or
 * an error; Meta always trails, holding the stat lines (llm model, duration,
 * tokens; code duration) that used to spend rows above the tab bar. Tab
 * choice follows the card's useState precedent, falling back to Script
 * whenever the chosen tab isn't offered.
 */
function CodeStepTabs({
  approvals,
  batches,
  llm,
  step,
  threadEvents,
}: {
  approvals: ActivityApprovalContext;
  batches: {
    offset: number;
    payload: RequestedPayload;
    resolved: ResolvedBatch | null;
    expired: boolean;
  }[];
  llm: AgentUiLlmStep | null;
  step: AgentUiCodeStep;
  threadEvents: StreamEvent[];
}) {
  const [selected, setSelected] = useState<"script" | "approvals" | "result" | "meta" | null>(null);
  // `as const` on the keys: without them the literals widen to string and
  // the inferred tab union collapses.
  const tabs = [
    { key: "script" as const, name: "Script" },
    ...(batches.length > 0 ? [{ key: "approvals" as const, name: "Approvals" }] : []),
    ...(step.status === "done" && (step.result !== undefined || step.errorMessage)
      ? [{ key: "result" as const, name: "Result" }]
      : []),
    { key: "meta" as const, name: "Meta" },
  ];
  const active =
    selected !== null && tabs.some((tab) => tab.key === selected) ? selected : "script";
  // The prompt replay only needs `messages`, and those fold purely from
  // events at or before the request offset — immutable history. So it runs
  // once the Meta tab is open AND the window has reached the request offset,
  // and it deliberately does NOT depend on `threadEvents`/`llm` identity:
  // live feed reductions recreate both on every stream event, and keying on
  // them would rerun the whole fold (filter + stringify + reduce) per event
  // while Meta is open. The offset plus the covered flag pin the exact same
  // input set. (Request-scoped lifecycle events feed only the replay's
  // response/stats, which this tab doesn't show — not fetched.)
  const requestCovered =
    llm !== null && threadEvents.length > 0 && threadEvents.at(-1)!.offset >= llm.llmRequestOffset;
  const llmRequestOffset = llm === null ? null : llm.llmRequestOffset;
  const promptReplay = useMemo(() => {
    if (active !== "meta" || llmRequestOffset === null || !requestCovered) return null;
    const relevant = threadEvents.filter(
      (event) => LLM_REPLAY_EVENT_TYPES.includes(event.type) && event.offset <= llmRequestOffset,
    );
    return replayLlmRequest({
      rawEventJsons: relevant.map((event) => JSON.stringify(event)),
      llmRequestOffset,
    });
    // threadEvents is read but deliberately excluded: covered history at a
    // fixed offset cannot change (see comment above the memo).
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [active, llmRequestOffset, requestCovered]);
  return (
    <View style={styles.stepBody}>
      <View style={styles.tabRow}>
        {tabs.map((tab) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: tab.key === active }}
            key={tab.key}
            onPress={() => setSelected(tab.key)}
            style={[styles.tab, tab.key === active && styles.tabActive]}
          >
            <Text style={[styles.tabLabel, tab.key === active && styles.tabLabelActive]}>
              {tab.name}
            </Text>
          </Pressable>
        ))}
      </View>
      {active === "script" ? (
        <>
          {step.code !== "" ? (
            <CodeBlock language="typescript" muted={false} text={step.code} />
          ) : null}
          {tabs.some((tab) => tab.key === "result") ? null : step.errorMessage ? (
            <Text style={styles.error}>{step.errorMessage}</Text>
          ) : null}
        </>
      ) : active === "approvals" ? (
        <View style={styles.tabBody}>
          {batches.map((batch) => (
            <View key={batch.offset} style={styles.batch}>
              {batch.resolved ? (
                <View style={styles.decisionRow}>
                  <Text
                    style={[
                      styles.outcomeBadge,
                      batch.resolved.decisionSummary === "Approved"
                        ? styles.approvedBadge
                        : styles.rejectedBadge,
                    ]}
                    testID="approval-decision-badge"
                  >
                    {batch.resolved.decisionSummary}
                  </Text>
                </View>
              ) : batch.expired ? (
                // Past its horizon with no decision: nobody can answer this
                // hold anymore. A plain note, not the resolved badge — the
                // door's expiry decision lands shortly and upgrades it.
                <Text style={styles.awaiting}>Expired</Text>
              ) : (
                <Text style={styles.awaiting}>Awaiting decision</Text>
              )}
              {batch.resolved?.reason ? (
                <Text style={styles.rejectReason}>Rejected because: {batch.resolved.reason}</Text>
              ) : null}
              <ApprovalBatchBody
                baseUrl={approvals.baseUrl}
                offset={batch.offset}
                payload={batch.payload}
                projectId={approvals.projectId}
                projectSlug={approvals.projectSlug}
                resolved={batch.resolved}
                // The card lives inside the thread this batch came from — a
                // provenance block here would point at itself.
                showScriptSource={false}
                showThreadInfo={false}
                surface={`activity:${step.executionId}`}
              />
            </View>
          ))}
        </View>
      ) : active === "meta" ? (
        <View style={styles.tabBody}>
          <CodeBlock
            language="yaml"
            text={metaYaml(llm, step, promptReplay?.messages || null)}
            muted
          />
        </View>
      ) : (
        <View style={styles.tabBody}>
          {step.result !== undefined ? (
            <CodeBlock language="yaml" text={previewResultYaml(step.result)} muted />
          ) : null}
          {step.errorMessage ? <Text style={styles.error}>{step.errorMessage}</Text> : null}
        </View>
      )}
    </View>
  );
}

/**
 * The Meta tab's body: the round's stats — and the replayed prompt — as one
 * YAML document for the highlighted CodeBlock. Emitted through the `yaml`
 * package rather than hand-rolled string building: prompt content is
 * arbitrary text, and block-scalar edge cases (a first line with leading
 * whitespace needs an explicit indent indicator, quoting, etc.) are the
 * library's problem. Absent fields are omitted, not nulled.
 */
function metaYaml(
  llm: AgentUiLlmStep | null,
  code: AgentUiCodeStep,
  promptMessages: { role: string; content: string }[] | null,
): string {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const doc = new Document({
    ...(llm && {
      llm: {
        ...(llm.model && { model: llm.model }),
        ...(llm.durationMs == null ? {} : { duration: seconds(llm.durationMs) }),
        ...(llm.inputTokens == null ? {} : { inputTokens: llm.inputTokens }),
        ...(llm.outputTokens == null ? {} : { outputTokens: llm.outputTokens }),
        ...(llm.outcome && llm.outcome !== "completed" && { outcome: llm.outcome }),
        ...(llm.cancelReason && { cancelReason: llm.cancelReason }),
      },
    }),
    code: {
      ...(code.status === "running" && { status: "running" }),
      ...(code.durationMs == null ? {} : { duration: seconds(code.durationMs) }),
      ...(code.status === "done" && code.success === false && { failed: true }),
    },
    ...(promptMessages &&
      promptMessages.length > 0 && {
        prompt: promptMessages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      }),
    // The raw model response the round's consequences were derived from —
    // after the prompt, so the doc reads request → answer (parity with the
    // os feed's buildRoundMetaYaml).
    ...(llm?.responseText && { response: llm.responseText }),
  });
  visit(doc, {
    // Multiline strings as |- blocks: readable and highlightable, instead of
    // the default quoted-with-\n form.
    Scalar(_key, node) {
      if (typeof node.value === "string" && node.value.includes("\n")) {
        node.type = Scalar.BLOCK_LITERAL;
      }
    },
    // The message/char tally rides as an inline comment on the prompt key.
    Pair(_key, pair) {
      if (promptMessages && pair.key instanceof Scalar && pair.key.value === "prompt") {
        const chars = promptMessages.reduce((sum, message) => sum + message.content.length, 0);
        pair.key.comment = ` ${promptMessages.length} messages, ${chars} chars`;
      }
    },
  });
  // lineWidth 0: never fold long lines — prompt text renders as written.
  return doc.toString({ lineWidth: 0 }).trimEnd();
}

function footerStats(step: Extract<AgentUiStep, { kind: "llm" }>): string {
  const parts = [
    ...(step.durationMs ? [`${(step.durationMs / 1000).toFixed(1)}s`] : []),
    ...(step.outputTokens ? [`${step.outputTokens} tok`] : []),
    ...(step.outcome === "failed" ? ["failed"] : []),
    ...(step.cancelReason === "interrupted-by-user-input"
      ? ["stopped for your new message"]
      : step.cancelReason === "expired"
        ? ["expired"]
        : step.outcome === "cancelled"
          ? ["cancelled"]
          : []),
  ];
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

// If the CodeMirror webview never reports ready in dev, flag it after this
// long instead of silently staying on plain text forever.
const EDITOR_READY_WATCHDOG_MS = 10_000;

// Progressive enhancement: a native monospace <Text> renders IMMEDIATELY (a
// native view cannot be blank), while the CodeMirror DOM component mounts
// invisibly behind it. Only a POSITIVE ready signal from inside the webview
// (the `onReady` function prop, marshaled across the expo/dom bridge exactly
// like `onChange`) swaps the highlighted editor in — if the webview's bundle
// never loads (the observed on-device failure: a blank fixed-height box),
// the text simply stays and the feed remains readable. In dev a watchdog
// badge appears when ready never arrives, so broken webviews get noticed
// and reported rather than papered over.
export function CodeBlock({
  language,
  text,
  muted,
}: {
  language: "json" | "typescript" | "yaml";
  text: string;
  muted: boolean;
}) {
  // The webview's readiness is remote truth ("did the EditorView mount over
  // there?"), so it is modeled as a mutation: `mutate` IS the ready
  // callback, and the swap derives from `.isSuccess` — no useState/useEffect.
  const editorReady = useMutation({ mutationFn: async () => {} });
  const watchdogId = useId();
  const watchdog = useQuery({
    queryKey: ["code-editor-ready-watchdog", watchdogId],
    queryFn: () =>
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), EDITOR_READY_WATCHDOG_MS)),
    enabled: __DEV__ && !editorReady.isSuccess,
    staleTime: Infinity,
  });
  const stalled = __DEV__ && !editorReady.isSuccess && watchdog.data;

  // The old webview height heuristic, kept as the container's fixed height so
  // the text → editor swap cannot cause a layout jump (CodeMirror fills
  // whatever box it is given).
  const lineCount = text.split("\n").length;
  const height = Math.min(260, Math.max(58, lineCount * 19 + 36));
  return (
    <View style={[styles.codeViewer, { height }, muted && styles.codeMuted]}>
      <View
        pointerEvents={editorReady.isSuccess ? "auto" : "none"}
        style={[styles.editorLayer, !editorReady.isSuccess && styles.editorLayerHidden]}
      >
        <CodeEditor
          dom={{ scrollEnabled: true, style: { flex: 1, height } }}
          editable={false}
          onChange={async () => {
            throw new Error("A read-only code block attempted to change.");
          }}
          onReady={async () => editorReady.mutate()}
          path={`snippet.${language === "typescript" ? "ts" : language}`}
          value={text}
        />
      </View>
      {editorReady.isSuccess ? null : (
        <ScrollView
          nestedScrollEnabled
          style={styles.textLayer}
          contentContainerStyle={styles.codeContent}
        >
          <Text selectable style={styles.codeText}>
            {text}
          </Text>
        </ScrollView>
      )}
      {stalled ? <Text style={styles.editorStalledBadge}>editor webview never ready</Text> : null}
    </View>
  );
}

/** While streaming, only the tail matters; full text is a tap away once settled. */
function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

/**
 * A script result as display YAML — same fold as the os web feed's
 * resultYaml (apps/os/src/lib/agent-round-meta-yaml.ts), plus the bounded
 * preview cap the JSON view used to apply.
 */
function previewResultYaml(value: unknown) {
  try {
    const doc = new Document(value);
    visit(doc, {
      Scalar(_key, node) {
        if (typeof node.value === "string" && node.value.includes("\n")) {
          node.type = Scalar.BLOCK_LITERAL;
        }
      },
    });
    const text = doc.toString({ lineWidth: 0 }).trimEnd();
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  } catch {
    return String(value);
  }
}

const styles = StyleSheet.create({
  card: {
    alignSelf: "stretch",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
  },
  cardLive: { borderColor: colors.working },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: 4,
  },
  chevron: { color: colors.textFaint, fontSize: 12, width: 14, textAlign: "center" },
  summary: { color: colors.textMuted, fontSize: 13, flexShrink: 1 },
  step: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.xs,
    gap: spacing.xs,
  },
  stepBody: { gap: spacing.xs },
  stepLabel: { color: colors.textFaint, fontSize: 11, textTransform: "uppercase" },
  roundHeader: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
  roundLabel: { color: colors.text, fontSize: 12, fontWeight: "700" },
  roundMeta: { color: colors.textFaint, fontSize: 11, flexShrink: 1 },
  glyphRow: { flexDirection: "row", gap: 4, marginLeft: "auto" },
  glyph: { fontSize: 12, fontWeight: "700" },
  phaseGlyph: { color: colors.working, fontSize: 12, fontWeight: "700" },
  glyphOpen: { color: colors.working },
  glyphApproved: { color: colors.accent },
  glyphRejected: { color: colors.danger },
  // A flat TAB bar, deliberately unlike any status badge: full-width
  // baseline rule, the active tab marked by a neutral-foreground underline
  // (never the accent — that is the approval badges' color), inactive
  // labels muted.
  tabRow: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  tab: {
    borderBottomColor: "transparent",
    borderBottomWidth: 2,
    marginBottom: -StyleSheet.hairlineWidth,
    paddingBottom: 4,
    paddingTop: 2,
  },
  tabActive: { borderBottomColor: colors.text },
  tabLabel: { color: colors.textFaint, fontSize: 12, fontWeight: "600" },
  tabLabelActive: { color: colors.text },
  tabBody: { gap: spacing.xs },
  batch: { gap: 4 },
  decisionRow: { flexDirection: "row" },
  awaiting: { color: colors.textMuted, fontSize: 12 },
  rejectReason: { color: colors.danger, fontSize: 12 },
  outcomeBadge: {
    borderRadius: radius.full,
    borderWidth: 1,
    fontSize: 11,
    fontWeight: "700",
    overflow: "hidden",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  approvedBadge: { borderColor: colors.accent, color: colors.accent },
  rejectedBadge: { borderColor: colors.danger, color: colors.danger },
  thinking: { color: colors.textMuted, fontSize: 12, fontStyle: "italic", lineHeight: 17 },
  codeViewer: {
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    overflow: "hidden",
    maxHeight: 260,
  },
  // The editor mounts underneath the text so it can become ready; opacity
  // (not unmounting) keeps the webview loading while the text shows.
  editorLayer: { ...StyleSheet.absoluteFillObject },
  editorLayerHidden: { opacity: 0 },
  textLayer: { flex: 1, backgroundColor: colors.background },
  editorStalledBadge: {
    position: "absolute",
    right: 4,
    top: 4,
    color: colors.danger,
    fontSize: 9,
  },
  codeContent: { padding: spacing.sm },
  codeText: {
    color: colors.text,
    fontFamily: "Menlo",
    fontSize: 12,
    lineHeight: 18,
  },
  codeMuted: { opacity: 0.72 },
  error: { color: colors.danger, fontSize: 12 },
});
