// The voice button on the floating note overlay — tap to start a
// PUSH-TO-TALK voice call with the project's voice agent (the phone as the
// third dumb client of the voice-agent facet). The first on-device session
// demoted open-mic to push-to-talk: hold the big mic to speak (ptt-start /
// mic frames / ptt-end, the C client's space bar with a thumb), release to
// let the model answer. The level bar above the mic throbs with LOCAL mic
// level while you hold — VU feedback only, zero latency, never a turn
// control.
//
// The sheet: level bar, the hold-to-talk mic, and ONE caption line shared
// by call lifecycle (ringing / hold to talk / listening) and the colleague
// status/note lane (grill Q6 — the phone can SHOW "backend: running code"
// while you wait). ✕ collapses the sheet; the call keeps going behind the
// floating button. No transcript, no scrollback.
//
// State lives in the query cache (the composer's precedent — no
// useState/useEffect); the live call handle and the pulse Animated.Value are
// module singletons because a call outlives any mount.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { Animated, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { getMobileDeviceId } from "../lib/device-identity.ts";
import { getProjectItx } from "../lib/itx.ts";
import { queryClient } from "../lib/query.ts";
import { colors, radius, spacing } from "../lib/theme.ts";
import { createNativeVoiceAudio } from "../lib/voice-audio-native.ts";
import { startVoiceCall, type VoiceCallHandle, type VoiceCallStatus } from "../lib/voice-call.ts";
import { ensureVoiceAgentSetup, mobileVoiceStreamPath } from "../lib/voice-setup.ts";

const statusKey = ["voice-call", "status"];
const sheetKey = ["voice-call", "sheet-open"];
const SETUP_MARKER_STORAGE_PREFIX = "voice-setup-marker:";

/** null = no call has ever run this app session. */
type VoiceUiStatus = (VoiceCallStatus & { micDenied?: boolean }) | null;

let activeCall: VoiceCallHandle | null = null;
/** Mic loudness 0..1, driven at capture-frame rate straight into the
 * animation — never through React state (16 Hz re-renders for a glow). */
const pulse = new Animated.Value(0);

async function beginCall(baseUrl: string, projectId: string): Promise<void> {
  const audio = createNativeVoiceAudio();
  if ((await audio.requestPermission()) !== "granted") {
    const denied: VoiceUiStatus = {
      phase: "ended",
      caption: "microphone access needed — tap to open Settings",
      micDenied: true,
    };
    queryClient.setQueryData<VoiceUiStatus>(statusKey, denied);
    return;
  }
  const project = await getProjectItx(baseUrl, projectId);
  const streamPath = mobileVoiceStreamPath(await getMobileDeviceId());
  const session = audio.createSession();
  queryClient.setQueryData(sheetKey, true);
  try {
    activeCall = await startVoiceCall({
      stream: (project as any).streams.get(streamPath),
      audio: session,
      ensureSetup: () =>
        ensureVoiceAgentSetup({
          workers: {
            get: (ref) => (project as any).workers.get(ref),
          },
          streamPath,
          readMarker: (path) => AsyncStorage.getItem(`${SETUP_MARKER_STORAGE_PREFIX}${path}`),
          writeMarker: (path, marker) =>
            AsyncStorage.setItem(`${SETUP_MARKER_STORAGE_PREFIX}${path}`, marker),
        }),
      onStatus: (status) => {
        if (status.phase === "ended") activeCall = null;
        queryClient.setQueryData<VoiceUiStatus>(statusKey, status);
      },
      onLevel: (level) => {
        /* JS-driven on purpose: the sheet's level bar animates WIDTH (a
         * layout prop the native driver rejects), and one Animated.Value
         * cannot serve both drivers. ~11 updates/s of a 6px bar is nothing
         * for the JS driver. */
        Animated.timing(pulse, { toValue: level, duration: 90, useNativeDriver: false }).start();
      },
      now: () => Date.now(),
    });
  } catch (error) {
    activeCall = null;
    await session.stop();
    const failed: VoiceUiStatus = {
      phase: "ended",
      caption: `call failed — ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        140,
      ),
    };
    queryClient.setQueryData<VoiceUiStatus>(statusKey, failed);
  }
}

export function VoiceCallButton(props: { baseUrl: string; projectId: string }) {
  const cache = useQueryClient();
  const { data: status } = useQuery<VoiceUiStatus>({
    queryKey: statusKey,
    queryFn: () => null,
    staleTime: Infinity,
    initialData: null,
  });
  const { data: sheetOpen } = useQuery<boolean>({
    queryKey: sheetKey,
    queryFn: () => false,
    staleTime: Infinity,
    initialData: false,
  });
  const start = useMutation({
    mutationFn: () => beginCall(props.baseUrl, props.projectId),
  });

  const inCall = status !== null && status.phase !== "ended";
  const onPressButton = () => {
    if (status?.micDenied) {
      void Linking.openSettings();
      return;
    }
    if (inCall) {
      cache.setQueryData(sheetKey, true);
      return;
    }
    if (!start.isPending) start.mutate();
  };

  const glowScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] });
  const glowOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.5] });
  const levelWidth = pulse.interpolate({ inputRange: [0, 1], outputRange: ["4%", "100%"] });

  return (
    <View pointerEvents="box-none">
      {inCall && sheetOpen ? (
        <View style={styles.sheet}>
          <View style={styles.levelTrack}>
            <Animated.View style={[styles.levelFill, { width: levelWidth }]} />
          </View>
          <Pressable
            accessibilityLabel="Hold to talk"
            accessibilityRole="button"
            onPressIn={() => activeCall?.setTalking(true)}
            onPressOut={() => activeCall?.setTalking(false)}
            style={({ pressed }) => [styles.talkButton, pressed && styles.talkButtonHeld]}
          >
            <Ionicons color={colors.text} name="mic" size={34} />
            <Text style={styles.talkHint}>hold to talk</Text>
          </Pressable>
          <Text numberOfLines={2} style={styles.caption}>
            {status.caption}
          </Text>
          <View style={styles.sheetControls}>
            <Pressable
              accessibilityLabel="Hide call"
              accessibilityRole="button"
              onPress={() => cache.setQueryData(sheetKey, false)}
              style={styles.sheetSecondary}
            >
              <Text style={styles.sheetSecondaryText}>✕</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Hang up"
              accessibilityRole="button"
              onPress={() => void activeCall?.hangUp()}
              style={styles.hangUp}
            >
              <Ionicons color={colors.text} name="call" size={20} style={styles.hangUpIcon} />
            </Pressable>
          </View>
        </View>
      ) : null}
      <View style={styles.buttonSlot} pointerEvents="box-none">
        {inCall ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.buttonGlow, { opacity: glowOpacity, transform: [{ scale: glowScale }] }]}
          />
        ) : null}
        <Pressable
          accessibilityLabel={inCall ? "Show voice call" : "Start a voice chat"}
          accessibilityRole="button"
          onPress={onPressButton}
          style={[styles.button, inCall && styles.buttonLive]}
        >
          <Ionicons color={inCall ? colors.background : colors.text} name="mic" size={22} />
        </Pressable>
        {!inCall && status?.phase === "ended" && status.caption !== "call ended" ? (
          <Pressable
            accessibilityLabel={status.micDenied ? "Open Settings" : "Dismiss"}
            onPress={() =>
              status.micDenied
                ? void Linking.openSettings()
                : cache.setQueryData<VoiceUiStatus>(statusKey, null)
            }
            style={styles.endedNote}
          >
            <Text numberOfLines={2} style={styles.endedNoteText}>
              {status.caption}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  buttonSlot: {
    alignSelf: "flex-end",
    marginRight: spacing.md,
    marginBottom: spacing.sm,
    alignItems: "center",
  },
  button: {
    width: 48,
    height: 48,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
  },
  buttonLive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  buttonGlow: {
    position: "absolute",
    width: 48,
    height: 48,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  endedNote: {
    maxWidth: 220,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
  },
  endedNoteText: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: "center",
  },
  sheet: {
    alignSelf: "flex-end",
    marginRight: spacing.md,
    marginBottom: spacing.sm,
    width: 300,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
  },
  levelTrack: {
    alignSelf: "stretch",
    height: 6,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceRaised,
    overflow: "hidden",
    marginBottom: spacing.md,
  },
  levelFill: {
    height: 6,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  talkButton: {
    width: 104,
    height: 104,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.accent,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  talkButtonHeld: {
    backgroundColor: colors.accent,
  },
  talkHint: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 2,
  },
  caption: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: "center",
    marginTop: spacing.sm,
    minHeight: 34,
  },
  sheetControls: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.sm,
    alignItems: "center",
  },
  sheetSecondary: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetSecondaryText: {
    color: colors.textMuted,
    fontSize: 16,
  },
  hangUp: {
    width: 52,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  hangUpIcon: {
    transform: [{ rotate: "135deg" }],
  },
});
