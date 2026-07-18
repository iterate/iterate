// One activity roll-up in the chat feed — the mobile rendering of the web's
// "Ran code 2× · 3 requests · 7.4s" rows (packages/ui agent-ui-reducer items).
// Collapsed: the one-line summary. Expanded (tap, or automatically while
// live-streaming): every step with its thinking text and code, updating
// token-by-token as chunks arrive over the stream subscription.

import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { summarizeAgentUiActivity } from "@iterate-com/ui/components/events/agent-ui-reducer";
import type { AgentUiActivity, AgentUiStep } from "../lib/feed.ts";
import { summarizeActivity } from "../lib/feed.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

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
          <ActivityIndicator size="small" color={colors.working} />
        ) : (
          <Text style={styles.chevron}>{expanded ? "▾" : "▸"}</Text>
        )}
        <Text style={styles.summary} numberOfLines={1}>
          {isLive ? liveSummary(activity) : summarizeActivity(activity)}
        </Text>
      </Pressable>
      {expanded ? activity.steps.map((step) => <StepView key={step.id} step={step} />) : null}
    </View>
  );
}

function liveSummary(activity: AgentUiActivity): string {
  const current = activity.steps.findLast((step) => step.status === "running");
  if (current?.kind === "code") return "running code…";
  if (current?.kind === "llm" && current.responseText !== "") return "writing code…";
  if (current?.kind === "llm" && current.thinkingText !== "") return "thinking…";
  if (current?.kind === "llm") return "waiting for a response…";
  if (summarizeAgentUiActivity(activity).restartPending) return "restarted — continuing…";
  return "working…";
}

function StepView({ step }: { step: AgentUiStep }) {
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
          {step.responseText !== "" ? <CodeBlock text={step.responseText} /> : null}
          {step.errorMessage ? <Text style={styles.error}>{step.errorMessage}</Text> : null}
        </>
      ) : (
        <>
          {step.code !== "" ? <CodeBlock text={step.code} /> : null}
          {step.status === "done" && step.result !== undefined ? (
            <CodeBlock text={`→ ${previewJson(step.result)}`} muted />
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
    ...(step.cancelReason === "durable-object-crashed"
      ? ["agent restarted"]
      : step.cancelReason === "interrupted-by-user-input"
        ? ["stopped for your new message"]
        : step.outcome === "cancelled"
          ? ["cancelled"]
          : []),
  ];
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

export function CodeBlock({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <ScrollView horizontal style={styles.codeScroll} contentContainerStyle={styles.codeContent}>
      <Text style={[styles.code, muted && styles.codeMuted]} selectable>
        {text}
      </Text>
    </ScrollView>
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
  code: { color: colors.text, fontFamily: "Menlo", fontSize: 12, lineHeight: 17 },
  codeMuted: { color: colors.textMuted },
  codeScroll: {
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    maxHeight: 260,
  },
  codeContent: { padding: spacing.sm },
  error: { color: colors.danger, fontSize: 12 },
});
