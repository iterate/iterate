// One activity roll-up in the chat feed — the mobile rendering of the web's
// "Ran code 2× · 3 requests · 7.4s" rows (packages/ui agent-ui-reducer items).
// Collapsed: the one-line summary. Expanded (tap, or automatically while
// live-streaming): every step with its thinking text and code, updating
// token-by-token as chunks arrive over the stream subscription.

import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
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

export function CodeBlock({
  language,
  text,
  muted,
}: {
  language: "json" | "typescript";
  text: string;
  muted: boolean;
}) {
  const lineCount = text.split("\n").length;
  const height = Math.min(260, Math.max(58, lineCount * 19 + 24));
  return (
    <View style={[styles.codeViewer, { height }, muted && styles.codeMuted]}>
      <CodeEditor
        dom={{ scrollEnabled: true, style: { flex: 1, height } }}
        editable={false}
        onChange={async () => {
          throw new Error("A read-only code block attempted to change.");
        }}
        path={`snippet.${language === "typescript" ? "ts" : language}`}
        value={text}
      />
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
  codeMuted: { opacity: 0.72 },
  error: { color: colors.danger, fontSize: 12 },
});
