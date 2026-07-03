import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { VoiceTranscriptEntry } from "../lib/voice/session-core.ts";
import { colors, spacing } from "../lib/theme.ts";

const LABELS: Record<VoiceTranscriptEntry["kind"], string> = {
  you: "you",
  assistant: "assistant",
  "worker-request": "→ worker",
  "worker-reply": "← worker",
  status: "•",
  error: "⚠",
};

export function Transcript({ entries }: { entries: VoiceTranscriptEntry[] }) {
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      // Newest at the bottom, keep it pinned there like a chat log.
      ref={(view) => view?.scrollToEnd({ animated: false })}
    >
      {entries.length === 0 ? (
        <Text style={styles.empty}>
          Your conversation — including what the worker agent is doing — shows up here.
        </Text>
      ) : (
        entries.map((entry) => <Row key={entry.id} entry={entry} />)
      )}
    </ScrollView>
  );
}

function Row({ entry }: { entry: VoiceTranscriptEntry }) {
  const workerLane = entry.kind === "worker-request" || entry.kind === "worker-reply";
  return (
    <View style={styles.row}>
      <Text style={[styles.label, entry.kind === "error" && { color: colors.danger }]}>
        {LABELS[entry.kind]}
      </Text>
      <Text
        style={[
          styles.text,
          entry.kind === "you" && styles.you,
          workerLane && styles.worker,
          entry.kind === "status" && styles.status,
          entry.kind === "error" && styles.error,
        ]}
      >
        {entry.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: spacing.md, gap: spacing.sm },
  empty: { color: colors.textFaint, fontSize: 13, lineHeight: 19 },
  row: { flexDirection: "row", gap: spacing.sm },
  label: { color: colors.textFaint, fontSize: 12, minWidth: 64, paddingTop: 2 },
  text: { color: colors.text, fontSize: 14, lineHeight: 20, flex: 1 },
  you: { fontWeight: "600" },
  worker: { color: colors.textMuted, fontFamily: "Menlo", fontSize: 12, lineHeight: 17 },
  status: { color: colors.textMuted, fontSize: 12 },
  error: { color: colors.danger, fontSize: 12 },
});
