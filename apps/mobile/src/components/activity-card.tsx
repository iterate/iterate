// One activity roll-up in the chat feed — the mobile rendering of the web's
// "Ran code 2× · 3 requests · 7.4s" rows (packages/ui agent-ui-reducer items).
// Collapsed: the one-line summary. Expanded (tap, or automatically while
// live-streaming): every step with its thinking text and code, updating
// token-by-token as chunks arrive over the stream subscription.

import { useId, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import { llmResponseForDisplay } from "../lib/activity-display.ts";
import type { AgentUiActivity, AgentUiStep } from "../lib/feed.ts";
import { summarizeActivity } from "../lib/feed.ts";
import { colors, radius, spacing } from "../lib/theme.ts";
import CodeEditor from "./code-editor.tsx";

export function ActivityCard({ activity }: { activity: AgentUiActivity }) {
  const isLive = activity.status !== "done";
  const [toggled, setToggled] = useState<boolean | null>(null);
  // Live activities stream open so you can watch the code being written;
  // settled ones collapse to their summary until tapped.
  const expanded = toggled ?? isLive;

  return (
    <View style={[styles.card, isLive && styles.cardLive]}>
      <Pressable style={styles.summaryRow} onPress={() => setToggled(!expanded)}>
        {isLive && activity.status === "running" ? (
          <ActivityIndicator accessibilityLabel="Loading" size="small" color={colors.working} />
        ) : (
          <Text style={styles.chevron}>{expanded ? "▾" : "▸"}</Text>
        )}
        <Text style={styles.summary} numberOfLines={1}>
          {isLive ? liveSummary(activity) : summarizeActivity(activity)}
        </Text>
      </Pressable>
      {expanded
        ? activity.steps.map((step, index) => (
            <StepView key={step.id} nextStep={activity.steps[index + 1]} step={step} />
          ))
        : null}
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

function StepView({ nextStep, step }: { nextStep: AgentUiStep | undefined; step: AgentUiStep }) {
  const responseText =
    step.kind === "llm"
      ? llmResponseForDisplay(
          step.responseText,
          nextStep?.kind === "code" ? nextStep.code : undefined,
        )
      : "";
  return (
    <View style={styles.step}>
      <Text style={styles.stepLabel}>
        {step.kind === "llm"
          ? `llm${step.model ? ` · ${step.model}` : ""}${footerStats(step)}`
          : `code${step.durationMs ? ` · ${(step.durationMs / 1000).toFixed(1)}s` : ""}${
              step.status === "done" && step.success === false ? " · failed" : ""
            }`}
      </Text>
      {step.kind === "llm" ? (
        <>
          {step.thinkingText !== "" ? (
            <Text style={styles.thinking}>{tail(step.thinkingText, 600)}</Text>
          ) : null}
          {responseText !== "" ? (
            <CodeBlock language="typescript" muted={false} text={responseText} />
          ) : null}
          {step.errorMessage ? <Text style={styles.error}>{step.errorMessage}</Text> : null}
        </>
      ) : (
        <>
          {step.code !== "" ? (
            <CodeBlock language="typescript" muted={false} text={step.code} />
          ) : null}
          {step.status === "done" && step.result !== undefined ? (
            <CodeBlock language="json" text={previewJson(step.result)} muted />
          ) : null}
          {step.errorMessage ? <Text style={styles.error}>{step.errorMessage}</Text> : null}
        </>
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
  const stalled = __DEV__ && !editorReady.isSuccess && watchdog.data === true;

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
  stepLabel: { color: colors.textFaint, fontSize: 11, textTransform: "uppercase" },
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
