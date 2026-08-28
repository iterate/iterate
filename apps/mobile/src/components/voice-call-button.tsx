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
import { Animated, Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { getMobileDeviceId } from "../lib/device-identity.ts";
import { getProjectItx } from "../lib/itx.ts";
import { queryClient } from "../lib/query.ts";
import { colors, radius, spacing } from "../lib/theme.ts";
import { createNativeVoiceAudio } from "../lib/voice-audio-native.ts";
import type { VoiceAudioSession } from "../lib/voice-audio.ts";
import { ringTonePcm16Base64 } from "../lib/voice-pcm.ts";
import { startVoiceCall, type VoiceCallHandle, type VoiceCallStatus } from "../lib/voice-call.ts";
import { ensureVoiceAgentSetup, mobileVoiceStreamPath } from "../lib/voice-setup.ts";

const statusKey = ["voice-call", "status"];
const sheetKey = ["voice-call", "sheet-open"];
const outputKey = ["voice-call", "output"];
const SETUP_MARKER_STORAGE_PREFIX = "voice-setup-marker:";

/** null = no call has ever run this app session. */
type VoiceUiStatus = (VoiceCallStatus & { micDenied?: boolean }) | null;

let activeCall: VoiceCallHandle | null = null;
let activeSession: VoiceAudioSession | null = null;
/** Generated once, lazily (~1s of PCM as base64). */
let ringTonePcm: string | null = null;
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
  activeSession = session;
  queryClient.setQueryData(sheetKey, true);
  /* Every call starts on the loudspeaker — hold-to-talk means the phone is
   * in front of you, not on your ear. */
  queryClient.setQueryData(outputKey, "speaker");
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
        if (status.phase === "ended") {
          activeCall = null;
          activeSession = null;
        }
        queryClient.setQueryData<VoiceUiStatus>(statusKey, status);
      },
      ringPcmBase64: (ringTonePcm ??= ringTonePcm16Base64()),
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
    activeSession = null;
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
  const { data: output } = useQuery<"speaker" | "earpiece">({
    queryKey: outputKey,
    queryFn: () => "speaker" as const,
    staleTime: Infinity,
    initialData: "speaker",
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
        <Modal
          animationType="fade"
          onRequestClose={() => cache.setQueryData(sheetKey, false)}
          transparent
          visible
        >
          {/* Anywhere outside the sheet minimises it — the call keeps going
              behind the floating button. */}
          <Pressable
            accessibilityLabel="Minimise call"
            onPress={() => cache.setQueryData(sheetKey, false)}
            style={styles.backdrop}
          />
          <View pointerEvents="box-none" style={styles.modalAnchor}>
            <View style={styles.sheet}>
              <View style={styles.levelTrack}>
                <Animated.View style={[styles.levelFill, { width: levelWidth }]} />
              </View>
              {status.phase === "live" ? (
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
              ) : (
                <View style={[styles.talkButton, styles.talkButtonRinging]}>
                  <Ionicons color={colors.textMuted} name="call" size={34} />
                </View>
              )}
              <Text numberOfLines={2} style={styles.caption}>
                {status.caption}
              </Text>
              <View style={styles.sheetControls}>
                <Pressable
                  accessibilityLabel={
                    output === "speaker" ? "Switch to earpiece" : "Switch to speaker"
                  }
                  accessibilityRole="button"
                  onPress={() => {
                    const next = output === "speaker" ? "earpiece" : "speaker";
                    cache.setQueryData(outputKey, next);
                    activeSession?.setOutput(next);
                  }}
                  style={styles.sheetSecondary}
                >
                  <Ionicons
                    color={colors.textMuted}
                    name={output === "speaker" ? "volume-high" : "ear"}
                    size={18}
                  />
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
          </View>
        </Modal>
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
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  modalAnchor: {
    flex: 1,
    justifyContent: "flex-end",
    alignItems: "flex-end",
    paddingBottom: 120,
  },
  sheet: {
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
  talkButtonRinging: {
    borderColor: colors.border,
    borderStyle: "dashed",
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
