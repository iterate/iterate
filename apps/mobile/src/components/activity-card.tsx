// One activity roll-up in the chat feed — the mobile rendering of the web's
// "Ran code 2× · 3 requests · 7.4s" rows (packages/ui agent-ui-reducer items).
// Collapsed: the one-line summary plus status glyphs (spinner while running,
// approval marks once the run parked batches at the egress door). Expanded
// (tap, or automatically while live-streaming): the run organized into
// ROUNDS — the llm step that writes a script and the code step that runs it
// — where each code step is a tabbed view: Script | Approvals | Result. The
// Approvals tab renders the SAME shared ApprovalBatchBody the Notifications
// expansion uses, so the in-context view can never drift from the archive.

import { useId, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { StreamEvent } from "iterate/sdk/itx/react";
import { llmResponseForDisplay } from "../lib/activity-display.ts";
import {
  deriveBatchesForExecution,
  summarizeBatchOutcomes,
  type RequestedPayload,
  type ResolvedBatch,
} from "../lib/approvals.ts";
import type { AgentUiActivity, AgentUiCodeStep, AgentUiLlmStep, AgentUiStep } from "../lib/feed.ts";
import { groupActivityRounds, summarizeActivity } from "../lib/feed.ts";
import { colors, radius, spacing } from "../lib/theme.ts";
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
}: {
  activity: AgentUiActivity;
  approvals: ActivityApprovalContext;
}) {
  const isLive = activity.status !== "done";
  const [toggled, setToggled] = useState<boolean | null>(null);
  // Live activities stream open so you can watch the code being written;
  // settled ones collapse to their summary until tapped.
  const expanded = toggled ?? isLive;
  const rounds = groupActivityRounds(activity.steps);
  const batchesByExecution = new Map(
    activity.steps
      .filter((step): step is AgentUiCodeStep => step.kind === "code")
      .map((step) => [
        step.executionId,
        deriveBatchesForExecution(approvals.events, step.executionId),
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
        <Text style={styles.summary} numberOfLines={1}>
          {isLive ? liveSummary(activity) : summarizeActivity(activity)}
        </Text>
        <ApprovalGlyphs outcomes={outcomes} />
      </Pressable>
      {expanded
        ? rounds.map((round, index) => (
            <View key={round.code?.id || round.llm?.id || index} style={styles.step}>
              {rounds.length > 1 ? <Text style={styles.roundLabel}>Round {index + 1}</Text> : null}
              {round.llm ? <LlmStepView code={round.code} step={round.llm} /> : null}
              {round.code ? (
                <CodeStepTabs
                  approvals={approvals}
                  batches={batchesByExecution.get(round.code.executionId) || []}
                  step={round.code}
                />
              ) : null}
            </View>
          ))
        : null}
    </View>
  );
}

/**
 * The collapsed card's approval marks: ◷ while any batch awaits its human,
 * ✓ when a batch was fully approved, ✗ when one was rejected or mixed — so
 * "did that run get its approvals?" reads without expanding anything.
 * No batches, no glyphs.
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

function liveSummary(activity: AgentUiActivity): string {
  const current = activity.steps.findLast((step) => step.status === "running");
  if (current?.kind === "code") return "running code…";
  if (current?.kind === "llm" && current.responseText !== "") return "writing code…";
  if (current?.kind === "llm" && current.thinkingText !== "") return "thinking…";
  if (current?.kind === "llm") return "waiting for a response…";
  return "working…";
}

function LlmStepView({ code, step }: { code: AgentUiCodeStep | null; step: AgentUiLlmStep }) {
  // Same next-step dedupe as before the rounds layout: the llm's response IS
  // the round's script, so it renders only where it differs from the code.
  const responseText = llmResponseForDisplay(step.responseText, code?.code);
  return (
    <View style={styles.stepBody}>
      <Text style={styles.stepLabel}>
        {`llm${step.model ? ` · ${step.model}` : ""}${footerStats(step)}`}
      </Text>
      {step.thinkingText !== "" ? (
        <Text style={styles.thinking}>{tail(step.thinkingText, 600)}</Text>
      ) : null}
      {responseText !== "" ? (
        <CodeBlock language="typescript" muted={false} text={responseText} />
      ) : null}
      {step.errorMessage ? <Text style={styles.error}>{step.errorMessage}</Text> : null}
    </View>
  );
}

/**
 * One code step as tabs. Script is always there; Approvals only when the
 * run parked batches at the egress door (rendered through the shared
 * ApprovalBatchBody — the same component the Notifications expansion uses,
 * so the two can't drift); Result only once the run settled with a value or
 * an error. Tab choice follows the card's useState precedent, falling back
 * to Script whenever the chosen tab isn't offered.
 */
function CodeStepTabs({
  approvals,
  batches,
  step,
}: {
  approvals: ActivityApprovalContext;
  batches: { offset: number; payload: RequestedPayload; resolved: ResolvedBatch | null }[];
  step: AgentUiCodeStep;
}) {
  const [selected, setSelected] = useState<"script" | "approvals" | "result" | null>(null);
  const tabs: ("script" | "approvals" | "result")[] = [
    "script",
    ...(batches.length > 0 ? ["approvals" as const] : []),
    ...(step.status === "done" && (step.result !== undefined || step.errorMessage)
      ? ["result" as const]
      : []),
  ];
  const active = selected !== null && tabs.includes(selected) ? selected : "script";
  return (
    <View style={styles.stepBody}>
      <Text style={styles.stepLabel}>
        {`code${step.durationMs ? ` · ${(step.durationMs / 1000).toFixed(1)}s` : ""}${
          step.status === "done" && step.success === false ? " · failed" : ""
        }`}
      </Text>
      {tabs.length > 1 ? (
        <View style={styles.tabRow}>
          {tabs.map((tab) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: tab === active }}
              key={tab}
              onPress={() => setSelected(tab)}
              style={[styles.tab, tab === active && styles.tabActive]}
            >
              <Text style={[styles.tabLabel, tab === active && styles.tabLabelActive]}>
                {tab === "script" ? "Script" : tab === "approvals" ? "Approvals" : "Result"}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {active === "script" ? (
        <>
          {step.code !== "" ? (
            <CodeBlock language="typescript" muted={false} text={step.code} />
          ) : null}
          {tabs.includes("result") ? null : step.errorMessage ? (
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
                  >
                    {batch.resolved.decisionSummary}
                  </Text>
                </View>
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
                showThreadInfo={false}
                surface={`activity:${step.executionId}`}
              />
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.tabBody}>
          {step.result !== undefined ? (
            <CodeBlock language="json" text={previewJson(step.result)} muted />
          ) : null}
          {step.errorMessage ? <Text style={styles.error}>{step.errorMessage}</Text> : null}
        </View>
      )}
    </View>
  );
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
  language: "json" | "typescript";
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
  const height = Math.min(260, Math.max(58, lineCount * 19 + 24));
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

function previewJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 1);
    return json.length > 2000 ? `${json.slice(0, 2000)}…` : json;
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
  roundLabel: { color: colors.text, fontSize: 12, fontWeight: "700" },
  glyphRow: { flexDirection: "row", gap: 4, marginLeft: "auto" },
  glyph: { fontSize: 12, fontWeight: "700" },
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
