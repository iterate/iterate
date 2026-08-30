// A JS error during a screen's render kills a production app dead — no red
// box, no message, just gone (the chat screen did exactly this on-device,
// 2026-08-31, and the crash was undiagnosable from the outside). This
// boundary turns a render/mount throw into a readable, screenshottable
// error page instead. Native (Objective-C/Swift) crashes still kill the
// process — those live in Settings → Privacy → Analytics crash logs.

import { Component, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { colors, spacing } from "../lib/theme.ts";

export class CrashGuard extends Component<
  { children: ReactNode; label: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <Text selectable style={styles.title}>
          The {this.props.label} screen hit an error
        </Text>
        <Text selectable style={styles.message}>
          {error.message}
        </Text>
        <Text selectable style={styles.stack}>
          {(error.stack || "").slice(0, 2000)}
        </Text>
      </ScrollView>
    );
  }
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.md },
  title: { color: colors.danger, fontSize: 16, fontWeight: "700" },
  message: { color: colors.text, fontSize: 14 },
  stack: { color: colors.textMuted, fontFamily: "Menlo", fontSize: 10 },
});
