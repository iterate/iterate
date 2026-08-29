// The WhatsApp-style call strip: while a call is live and you're anywhere
// but its chat, the top bar extends down as a green band — status caption
// inside, tap to jump back to the call's chat (where the hold-to-talk
// controls float). It owns the status-bar zone like WhatsApp's does; the
// screen below keeps its own header, so the band simply pushes everything
// down while it exists.
import { router, useGlobalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { spacing } from "../lib/theme.ts";
import {
  useVoiceCallActive,
  useVoiceCallStatus,
  useVoiceCallTarget,
} from "../lib/voice-call-state.ts";

export function VoiceCallBanner() {
  const insets = useSafeAreaInsets();
  const active = useVoiceCallActive();
  const status = useVoiceCallStatus();
  const target = useVoiceCallTarget();
  const params = useGlobalSearchParams<{ path?: string }>();
  /* On the call's own chat the floating controls are the call UI; the
   * banner covers everywhere else. */
  if (!active || target === null || params.path === target.colleaguePath) return null;
  return (
    <Pressable
      accessibilityLabel="Return to voice call"
      accessibilityRole="button"
      onPress={() =>
        router.push({
          pathname: "/project/[projectId]/chat",
          params: { projectId: target.projectId, path: target.colleaguePath },
        })
      }
      style={[styles.banner, { paddingTop: insets.top + 2 }]}
    >
      <Text numberOfLines={1} style={styles.text}>
        <Ionicons name="call" size={13} color="#dff7e4" /> Voice call · {status?.caption || "live"}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: "#1da851",
    paddingBottom: 8,
    paddingHorizontal: spacing.md,
    alignItems: "center",
  },
  text: { color: "#dff7e4", fontSize: 13, fontWeight: "600" },
});
