// The Telegram-style record button that lives in the send slot while the
// composer is empty: hold to record a voice clip, release to attach it,
// slide left to cancel, slide up to lock hands-free (then Cancel / stop).
// A quick tap flips mic ↔ video (with the explainer tooltip); video mode
// records the front camera into a circular viewport, like the screenshots.
//
// The gesture's branching is lib/record-gesture.ts (pure, unit-tested);
// this file maps PanResponder events in and performs the effects. Chat only
// renders this on native (web keeps the plain dimmed send button).
//
// A finished clip ATTACHES (chips row) rather than sending — Telegram sends
// on release, but nothing in this composer auto-sends by design.

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PanResponder, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  getRecordingPermissionsAsync,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { Camera, CameraView } from "expo-camera";
import * as FileSystem from "expo-file-system/legacy";
import { formatClipDuration, type ComposerAttachment } from "../lib/composer-attachments.ts";
import {
  cancelProgress,
  reduceRecordGesture,
  type RecordGestureEvent,
  type RecordGestureState,
} from "../lib/record-gesture.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

const BUTTON = 38;
const TOOLTIP_MS = 1600;

/** One press-to-release lifecycle. The async permission/prepare steps race
 * the finger: every await checks `outcome` afterward and backs out if the
 * gesture already resolved. */
type RecordSession = {
  outcome: "recording" | "finish" | "cancel" | null;
  startedAt: number;
  mode: "mic" | "video";
};

/** The outcome as of NOW: resolveSession mutates it from outside the async
 * recording flows, and an inline property read gets control-flow-narrowed to
 * its pre-await value. */
function liveOutcome(session: RecordSession): RecordSession["outcome"] {
  return session.outcome;
}

export function RecordControls(props: { onAttach: (attachment: ComposerAttachment) => void }) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const window = useWindowDimensions();

  const [mode, setMode] = useState<"mic" | "video">("mic");
  const [gesture, setGesture] = useState<RecordGestureState>({ phase: "idle" });
  const [session, setSession] = useState<RecordSession | null>(null);
  const [tooltip, setTooltip] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The PanResponder is created once; everything it needs lives in refs.
  const machineRef = useRef<RecordGestureState>({ phase: "idle" });
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const sessionRef = useRef<RecordSession | null>(null);
  const tooltipGeneration = useRef(0);
  const cameraRef = useRef<CameraView>(null);
  const cameraReadyRef = useRef(false);
  const videoResultRef = useRef<Promise<{ uri: string } | undefined> | null>(null);

  const showTooltip = (text: string) => {
    tooltipGeneration.current += 1;
    const generation = tooltipGeneration.current;
    setTooltip(text);
    setTimeout(() => {
      if (tooltipGeneration.current === generation) setTooltip(null);
    }, TOOLTIP_MS);
  };

  const beginSession = () => {
    const nextSession: RecordSession = {
      outcome: "recording",
      startedAt: Date.now(),
      mode: modeRef.current,
    };
    sessionRef.current = nextSession;
    setSession(nextSession);
    setError(null);
    if (nextSession.mode === "mic") void runMicSession(nextSession);
    // Video: the circular CameraView is pre-warmed the moment the mode
    // flips to video (mounted invisibly below), so it is usually ready
    // before the hold starts; otherwise onCameraReady starts the recording
    // when it arrives. Calling recordAsync before readiness is the
    // "Camera is not ready. Wait for 'onCameraReady' callback" crash.
    if (nextSession.mode === "video" && cameraReadyRef.current) startVideoRecording();
  };

  const runMicSession = async (current: RecordSession) => {
    try {
      const existing = await getRecordingPermissionsAsync();
      const permission = existing.granted ? existing : await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        throw new Error("Microphone permission was refused — allow it in Settings.");
      }
      if (current.outcome !== "recording") return;
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (current.outcome !== "recording") return;
      recorder.record();
      // The finger may have resolved the gesture while prepare ran. The
      // outcome mutates from outside this async flow, so read it through a
      // call TypeScript can't narrow away.
      if (liveOutcome(current) === "finish") await deliverMic(current);
      if (liveOutcome(current) === "cancel") await discardMic();
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
      endSession(current);
    }
  };

  const deliverMic = async (current: RecordSession) => {
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (uri === null) throw new Error("The recorder produced no file");
      // The recorder reuses its output path; copy the clip somewhere stable
      // so a second recording can't overwrite an attached-but-unsent one.
      let stableUri = uri;
      if (FileSystem.cacheDirectory !== null) {
        stableUri = `${FileSystem.cacheDirectory}voice-${current.startedAt}.m4a`;
        await FileSystem.copyAsync({ from: uri, to: stableUri });
      }
      props.onAttach({
        kind: "audio",
        filename: `voice-${current.startedAt}.m4a`,
        contentType: "audio/mp4",
        uri: stableUri,
        durationSeconds: (Date.now() - current.startedAt) / 1000,
      });
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      endSession(current);
    }
  };

  const discardMic = async () => {
    await recorder.stop().catch(() => {});
    endSession(sessionRef.current);
  };

  const startVideoRecording = () => {
    const current = sessionRef.current;
    if (current === null || current.outcome !== "recording" || cameraRef.current === null) return;
    if (current.mode !== "video" || videoResultRef.current !== null) return;
    videoResultRef.current = cameraRef.current.recordAsync({ maxDuration: 60 });
    void videoResultRef.current
      .then(async (video) => {
        const outcome = sessionRef.current?.outcome;
        if (outcome === "finish" && video) {
          props.onAttach({
            kind: "video",
            assetId: null,
            filename: `video-${current.startedAt}.mov`,
            contentType: "video/quicktime",
            uri: video.uri,
            previewUri: null,
            durationSeconds: (Date.now() - current.startedAt) / 1000,
            sizeBytes: null,
            width: null,
            height: null,
          });
        }
        endSession(current);
      })
      .catch((thrown: unknown) => {
        setError(thrown instanceof Error ? thrown.message : String(thrown));
        endSession(current);
      });
  };

  const endSession = (current: RecordSession | null) => {
    if (sessionRef.current !== current) return;
    sessionRef.current = null;
    setSession(null);
    videoResultRef.current = null;
    void setAudioModeAsync({ allowsRecording: false }).catch(() => {});
  };

  const resolveSession = (outcome: "finish" | "cancel") => {
    const current = sessionRef.current;
    if (current === null) return;
    const wasRecording = current.outcome === "recording";
    current.outcome = outcome;
    if (current.mode === "mic") {
      // If prepare is still in flight, runMicSession sees the outcome after
      // its awaits and delivers/discards itself.
      if (wasRecording && recorder.isRecording) {
        if (outcome === "finish") void deliverMic(current);
        else void discardMic();
      }
    } else {
      if (videoResultRef.current === null) {
        // Camera never became ready — nothing recorded.
        endSession(current);
      } else {
        // recordAsync resolves via stopRecording; the then() above checks
        // the outcome to attach or discard.
        cameraRef.current?.stopRecording();
      }
    }
  };

  const toggleMode = () => {
    const current = sessionRef.current;
    if (current !== null) {
      current.outcome = "cancel";
      if (current.mode === "mic") void discardMic();
      else endSession(current);
    }
    const next = modeRef.current === "mic" ? "video" : "mic";
    if (next === "mic") cameraReadyRef.current = false;
    setMode(next);
    showTooltip(
      next === "video"
        ? "Hold to record video. Tap to switch to audio."
        : "Hold to record audio. Tap to switch to video.",
    );
    if (next === "video") {
      // Ask up front so the first hold doesn't die on a permission dialog.
      void Camera.requestCameraPermissionsAsync();
      void Camera.requestMicrophonePermissionsAsync();
    }
  };

  const dispatch = (event: RecordGestureEvent) => {
    const next = reduceRecordGesture(machineRef.current, event);
    machineRef.current = next.state;
    setGesture(next.state);
    switch (next.effect) {
      case "start-recording":
        beginSession();
        break;
      case "finish":
        resolveSession("finish");
        break;
      case "cancel":
        resolveSession("cancel");
        break;
      case "toggle-mode":
        toggleMode();
        break;
      case "none":
        break;
    }
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => dispatch({ type: "press-in", at: Date.now() }),
      onPanResponderMove: (_event, state) => dispatch({ type: "move", dx: state.dx, dy: state.dy }),
      onPanResponderRelease: () => dispatch({ type: "press-out", at: Date.now() }),
      onPanResponderTerminate: () => dispatch({ type: "press-out", at: Date.now() }),
    }),
  ).current;

  // Elapsed-time display without an interval effect: a query that refetches
  // while a session is live.
  const clock = useQuery({
    queryKey: ["record-controls-clock"],
    queryFn: async () => Date.now(),
    refetchInterval: session === null ? false : 250,
    enabled: session !== null,
  });
  const elapsed =
    session === null
      ? 0
      : Math.max(0, (clock.data || session.startedAt) - session.startedAt) / 1000;

  const recording = session !== null;
  const locked = gesture.phase === "locked";
  const hudWidth = window.width - spacing.md * 2 - BUTTON;
  const circle = Math.min(window.width * 0.72, 300);
  // The wrapper sits at the row's right edge; place the circle at the
  // screen's horizontal center relative to it.
  const circleLeft = window.width / 2 - circle / 2 - (window.width - spacing.md - BUTTON);

  return (
    <View collapsable={false} style={styles.slot}>
      {mode === "video" ? (
        // Mounted (and warming) from the moment video mode is armed, but only
        // VISIBLE while a video session records — recordAsync must not run
        // before onCameraReady, and warming during the tooltip beat is what
        // makes hold-to-record start instantly.
        <View
          pointerEvents="none"
          style={[
            styles.videoCircle,
            { width: circle, height: circle, borderRadius: circle / 2, left: circleLeft },
            recording && session.mode === "video" ? null : styles.videoCircleWarming,
          ]}
        >
          <CameraView
            facing="front"
            mode="video"
            onCameraReady={() => {
              cameraReadyRef.current = true;
              // A hold that began before the camera finished warming is
              // waiting on this.
              startVideoRecording();
            }}
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
          />
        </View>
      ) : null}
      {recording ? (
        <View style={[styles.hud, { width: hudWidth }]}>
          <View style={styles.redDot} />
          <Text style={styles.timer}>{formatClipDuration(elapsed)}</Text>
          {locked ? (
            <Pressable
              accessibilityLabel="Cancel recording"
              accessibilityRole="button"
              hitSlop={10}
              onPress={() => dispatch({ type: "cancel-tap" })}
              style={styles.cancelButton}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          ) : (
            <Text style={[styles.slideHint, { opacity: 1 - cancelProgress(gesture) }]}>
              ‹ Slide to cancel
            </Text>
          )}
        </View>
      ) : null}
      {recording && !locked ? (
        <View style={styles.lockHint}>
          <Ionicons name="lock-open-outline" size={16} color={colors.textMuted} />
          <Ionicons name="chevron-up" size={14} color={colors.textMuted} />
        </View>
      ) : null}
      {tooltip !== null ? (
        <View style={styles.tooltip}>
          <Text style={styles.tooltipText}>{tooltip}</Text>
        </View>
      ) : null}
      {error !== null ? (
        <View style={styles.tooltip}>
          <Text style={[styles.tooltipText, { color: colors.danger }]}>{error}</Text>
        </View>
      ) : null}
      {locked ? (
        <Pressable
          accessibilityLabel="Stop recording and attach"
          accessibilityRole="button"
          onPress={() => dispatch({ type: "stop-tap" })}
          style={[styles.button, styles.buttonActive]}
        >
          <Ionicons name="stop" size={18} color={colors.background} />
        </Pressable>
      ) : (
        <View
          {...pan.panHandlers}
          accessibilityLabel={
            mode === "mic"
              ? "Hold to record audio. Tap to switch to video."
              : "Hold to record video. Tap to switch to audio."
          }
          accessibilityRole="button"
          style={[styles.button, recording && styles.buttonActive]}
        >
          <Ionicons
            name={mode === "mic" ? "mic" : "videocam"}
            size={20}
            color={recording ? colors.background : colors.textMuted}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  slot: {
    width: BUTTON,
    height: BUTTON,
    // Overflow stays visible: the HUD, lock hint, tooltip, and video circle
    // all render outside this 38px slot on purpose.
  },
  button: {
    width: BUTTON,
    height: BUTTON,
    borderRadius: radius.full,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
    transform: [{ scale: 1.25 }],
  },
  hud: {
    position: "absolute",
    right: BUTTON + spacing.sm,
    bottom: 0,
    height: BUTTON,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.background,
  },
  redDot: {
    width: 10,
    height: 10,
    borderRadius: radius.full,
    backgroundColor: colors.danger,
  },
  timer: { color: colors.text, fontSize: 14, fontVariant: ["tabular-nums"] },
  slideHint: {
    flex: 1,
    textAlign: "center",
    color: colors.textMuted,
    fontSize: 13,
  },
  cancelButton: { flex: 1, alignItems: "center" },
  cancelText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
  lockHint: {
    position: "absolute",
    bottom: BUTTON + spacing.md,
    right: 4,
    alignItems: "center",
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: 6,
    paddingVertical: 8,
    gap: 2,
  },
  tooltip: {
    position: "absolute",
    bottom: BUTTON + spacing.md,
    right: 0,
    width: 250,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  tooltipText: { color: colors.text, fontSize: 12, textAlign: "center" },
  videoCircle: {
    position: "absolute",
    bottom: BUTTON + 70,
    overflow: "hidden",
    borderColor: colors.border,
    borderWidth: 1,
    backgroundColor: colors.surface,
  },
  videoCircleWarming: { opacity: 0 },
});
