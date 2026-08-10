// Root error boundary — the app previously had none, so a render crash was a
// blank screen. Logs the error durably (session-log) and offers a reload.
// Class component because that's the only React error-boundary mechanism.
import { Component, type ReactNode } from "react";
import * as Updates from "expo-updates";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { logError } from "../lib/session-log.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

export class SessionErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    logError("react-render", error, {
      componentStack: (info.componentStack || "").slice(0, 2000),
    });
  }

  reload = () => {
    if (Updates.isEnabled) {
      void Updates.reloadAsync().catch(() => this.setState({ error: null }));
    } else {
      this.setState({ error: null });
    }
  };

  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Something broke</Text>
        <Text selectable style={styles.message}>
          {this.state.error.message}
        </Text>
        <Pressable accessibilityRole="button" onPress={this.reload} style={styles.button}>
          <Text style={styles.buttonLabel}>Reload app</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    backgroundColor: colors.background,
    flex: 1,
    gap: spacing.md,
    justifyContent: "center",
    padding: spacing.lg,
  },
  title: { color: colors.text, fontSize: 20, fontWeight: "700" },
  message: { color: colors.textMuted, fontSize: 14, textAlign: "center" },
  button: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
  },
  buttonLabel: { color: colors.text, fontSize: 16, fontWeight: "600" },
});
