// The in-call UI: every call is a PHONE CALL TO A CHAT (the chat's agent
// is the backend via the certificate's colleaguePath; there is no separate
// device line any more). Calls start from a chat's header phone button or
// the chat list's "new phone chat" button — startChatCall is the one entry
// point — and the floating mic + sheet here float over the call's own chat
// (the root layout's VoiceCallBanner covers every other screen).
//
// PUSH-TO-TALK: hold the big mic to speak (ptt-start / mic frames /
// ptt-end), release to let the model answer; the level bar throbs with
// LOCAL mic level — VU feedback only, never a turn control. The sheet also
// carries the live transcript (both sides + backend notes/statuses) off
// the stream's durable events; tap outside to minimise.
//
// State lives in the query cache (the composer's precedent — no
// useState/useEffect); the live call handle and the pulse Animated.Value are
// module singletons because a call outlives any mount.
import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import {
  Animated,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { getProjectItx } from "../lib/itx.ts";
import { colors, radius, spacing } from "../lib/theme.ts";
import { useLiveEvents } from "../lib/use-live-events.ts";
import { transcriptItems, TRANSCRIPT_EVENT_TYPES } from "../lib/voice-call.ts";
import {
  getActiveCall,
  getActiveSession,
  pulse,
  startChatCall,
  voiceCallOutputKey as outputKey,
  voiceCallSheetKey as sheetKey,
} from "../lib/voice-call-session.ts";
import {
  voiceCallStatusKey as statusKey,
  useVoiceCallTarget,
  type VoiceUiStatus,
} from "../lib/voice-call-state.ts";
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
    queryFn: () => "speaker",
    staleTime: Infinity,
    initialData: "speaker",
  });
  const inCall = status !== null && status.phase !== "ended";
  const onPressButton = () => {
    if (status?.micDenied) {
      void Linking.openSettings();
      return;
    }
    if (inCall) cache.setQueryData(sheetKey, true);
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
              <CallTranscript baseUrl={props.baseUrl} projectId={props.projectId} />
              <View style={styles.levelTrack}>
                <Animated.View style={[styles.levelFill, { width: levelWidth }]} />
              </View>
              {status.phase === "live" ? (
                <Pressable
                  accessibilityLabel="Hold to talk"
                  accessibilityRole="button"
                  onPressIn={() => getActiveCall()?.setTalking(true)}
                  onPressOut={() => getActiveCall()?.setTalking(false)}
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
                    getActiveSession()?.setOutput(next);
                  }}
                  style={[
                    styles.sheetSecondary,
                    /* One speaker icon, WhatsApp-style: lit pill = on
                     * loudspeaker, dark = earpiece. */
                    output === "speaker" && styles.sheetSecondaryActive,
                  ]}
                >
                  <Ionicons
                    color={output === "speaker" ? colors.background : colors.textMuted}
                    name="volume-high"
                    size={18}
                  />
                </Pressable>
                <Pressable
                  accessibilityLabel="Hang up"
                  accessibilityRole="button"
                  onPress={() => void getActiveCall()?.hangUp()}
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
          accessibilityLabel="Show voice call"
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

/**
 * The frontend conversation, live, off the stream's own durable events —
 * what was said (both sides), the backend's notes, and its status line.
 * The same events brief reconnects and land on the colleague's stream, so
 * this view IS the record. Last dozen lines, pinned to the tail.
 */
function CallTranscript(props: { baseUrl: string; projectId: string }) {
  const target = useVoiceCallTarget();
  const streamPath = target?.streamPath || "";
  const events = useLiveEvents({
    queryKey: ["voice-transcript", props.baseUrl, props.projectId, streamPath],
    read: async () => {
      const project = await getProjectItx(props.baseUrl, props.projectId);
      return await (project as any).streams.get(streamPath).getEvents({});
    },
    enabled: streamPath !== "",
    eventTypes: TRANSCRIPT_EVENT_TYPES,
    projectId: props.projectId,
    streamPath,
  });
  const scroll = useRef<ScrollView | null>(null);
  const items = transcriptItems(events.data || []).slice(-12);
  if (items.length === 0) return null;
  return (
    <ScrollView
      onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      ref={scroll}
      style={styles.transcript}
    >
      {items.map((item) => (
        <Text
          key={item.key}
          style={[
            styles.transcriptLine,
            item.kind === "you" && styles.transcriptYou,
            item.kind === "status" && styles.transcriptStatus,
            item.kind === "backend" && styles.transcriptBackend,
          ]}
        >
          {item.kind === "you" ? "you · " : item.kind === "backend" ? "backend · " : ""}
          {item.text}
        </Text>
      ))}
    </ScrollView>
  );
}

/**
 * The phone button a chat header wears: call THIS chat — its agent becomes
 * the call's backend (the certificate's colleaguePath), the conversation
 * lands on its stream. One call at a time app-wide, like a phone: while any
 * call is live the button just reopens the sheet (the floating overlay owns
 * the in-call UI).
 */
export function VoiceCallChatButton(props: { baseUrl: string; projectId: string; path: string }) {
  const cache = useQueryClient();
  const { data: status } = useQuery<VoiceUiStatus>({
    queryKey: statusKey,
    queryFn: () => null,
    staleTime: Infinity,
    initialData: null,
  });
  const start = useMutation({
    mutationFn: () => startChatCall(props.baseUrl, props.projectId, props.path),
  });
  const inCall = status !== null && status.phase !== "ended";
  return (
    <Pressable
      accessibilityLabel={inCall ? "Show voice call" : "Call this chat"}
      accessibilityRole="button"
      onPress={() => {
        if (inCall) {
          cache.setQueryData(sheetKey, true);
          return;
        }
        if (!start.isPending) start.mutate();
      }}
      style={styles.headerCall}
    >
      <Ionicons color={inCall ? colors.accent : colors.text} name="call" size={20} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerCall: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  transcript: {
    alignSelf: "stretch",
    maxHeight: 170,
    marginBottom: spacing.md,
  },
  transcriptLine: {
    color: colors.text,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 2,
  },
  transcriptYou: {
    color: colors.textMuted,
  },
  transcriptBackend: {
    color: colors.accent,
  },
  transcriptStatus: {
    color: colors.textMuted,
    fontStyle: "italic",
    fontSize: 11,
  },
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
  sheetSecondaryActive: {
    backgroundColor: colors.text,
    borderColor: colors.text,
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
