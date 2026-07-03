import { useEffect, useState, useSyncExternalStore } from "react";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Orb, type OrbState } from "../../../components/orb.tsx";
import { Transcript } from "../../../components/transcript.tsx";
import { getItxSession, resetItxSession } from "../../../lib/itx.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";
import { VoiceSessionCore, type WorkerStream } from "../../../lib/voice/session-core.ts";
import { webrtcRealtimeConnector } from "../../../lib/voice/webrtc.ts";

export default function VoiceScreen() {
  const { projectId, path } = useLocalSearchParams<{
    projectId: string;
    slug?: string;
    path: string;
  }>();
  useKeepAwake();

  const [session] = useState(() => createSession({ projectId, agentPath: path }));
  // Imperative native session lifecycle — the sanctioned exception to the
  // no-useEffect rule: the mic/WebRTC leg must start when the screen appears
  // and MUST be torn down when it disappears, or audio keeps flowing after
  // navigating away.
  useEffect(() => {
    void session.start();
    return () => session.stop();
  }, [session]);

  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [message, setMessage] = useState("");
  const [showTranscript, setShowTranscript] = useState(false);

  const orbState: OrbState =
    snapshot.status === "connecting"
      ? "connecting"
      : snapshot.status !== "live"
        ? "ended"
        : snapshot.assistantSpeaking
          ? "speaking"
          : snapshot.workerBusy
            ? "thinking"
            : snapshot.micLive && !snapshot.muted
              ? "listening"
              : "idle";

  const caption =
    snapshot.status === "connecting"
      ? "connecting…"
      : snapshot.status === "ended"
        ? "session ended"
        : snapshot.assistantSpeaking
          ? "speaking"
          : snapshot.workerBusy
            ? "worker is on it…"
            : snapshot.muted
              ? "muted"
              : snapshot.micLive
                ? "listening — just talk"
                : "type below — no microphone";

  const live = snapshot.status === "live";
  const micDenied = live && !snapshot.micLive;
  const lastError = [...snapshot.entries].reverse().find((entry) => entry.kind === "error");

  function submitText() {
    if (!message.trim()) return;
    session.sendText(message);
    setMessage("");
  }

  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <Stack.Screen
        options={{ title: path.replace(/^\/agents\/voice\//, "").slice(0, 24) || "voice" }}
      />
      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={100}
      >
        {showTranscript ? (
          <View style={styles.transcriptPane}>
            <Transcript entries={snapshot.entries} />
          </View>
        ) : (
          <View style={styles.stage}>
            <Orb state={orbState} />
            <Text style={styles.caption}>{caption}</Text>
            {orbState === "ended" && lastError ? (
              <Text style={styles.errorCaption}>{lastError.text}</Text>
            ) : null}
            {micDenied ? (
              <Pressable onPress={() => Linking.openSettings()}>
                <Text style={styles.settingsLink}>enable the microphone in Settings</Text>
              </Pressable>
            ) : null}
            {snapshot.status === "ended" ? (
              <Pressable
                style={styles.restart}
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  void session.start();
                }}
              >
                <Text style={styles.restartText}>Start again</Text>
              </Pressable>
            ) : null}
          </View>
        )}

        <View style={styles.textRow}>
          <TextInput
            value={message}
            onChangeText={setMessage}
            onSubmitEditing={submitText}
            editable={live}
            returnKeyType="send"
            placeholder={live ? "Type instead of speaking…" : "Session not live"}
            placeholderTextColor={colors.textFaint}
            style={styles.input}
          />
          <Pressable
            onPress={submitText}
            disabled={!live || !message.trim()}
            style={[styles.sendButton, (!live || !message.trim()) && { opacity: 0.4 }]}
          >
            <Text style={styles.sendButtonText}>↑</Text>
          </Pressable>
        </View>

        <View style={styles.controls}>
          <ControlButton
            label={snapshot.muted ? "unmute" : "mute"}
            active={snapshot.muted}
            disabled={!live || !snapshot.micLive}
            onPress={() => session.setMuted(!snapshot.muted)}
          />
          <ControlButton
            label={showTranscript ? "orb" : "transcript"}
            active={showTranscript}
            onPress={() => setShowTranscript(!showTranscript)}
          />
          <ControlButton
            label="end"
            danger
            disabled={!live && snapshot.status !== "connecting"}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              session.stop();
            }}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ControlButton(props: {
  label: string;
  onPress: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      style={[
        styles.control,
        props.active && styles.controlActive,
        props.danger && styles.controlDanger,
        props.disabled && { opacity: 0.35 },
      ]}
    >
      <Text style={[styles.controlText, props.danger && { color: colors.danger }]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function createSession(input: { projectId: string; agentPath: string }) {
  const projectItx = async () => {
    const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
    try {
      const itx = await getItxSession(baseUrl);
      return await itx.projects.get(input.projectId);
    } catch (error) {
      resetItxSession();
      throw error;
    }
  };
  return new VoiceSessionCore({
    connectRealtime: webrtcRealtimeConnector({
      mint: async () => (await projectItx()).voice.mintRealtimeConnection(),
      withMic: true,
    }),
    agentStream: async () => {
      const project = await projectItx();
      return project.agents.get(input.agentPath).stream as unknown as WorkerStream;
    },
    hooks: {
      onWorkerReport: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
    },
  });
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  body: { flex: 1 },
  stage: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md },
  caption: { color: colors.textMuted, fontSize: 15 },
  errorCaption: {
    color: colors.danger,
    fontSize: 12,
    paddingHorizontal: spacing.xl,
    textAlign: "center",
  },
  settingsLink: { color: colors.connecting, fontSize: 13, textDecorationLine: "underline" },
  restart: {
    backgroundColor: colors.text,
    borderRadius: radius.full,
    paddingHorizontal: spacing.xl,
    paddingVertical: 12,
    marginTop: spacing.sm,
  },
  restartText: { color: colors.background, fontSize: 15, fontWeight: "600" },
  transcriptPane: { flex: 1 },
  textRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.full,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  sendButton: {
    backgroundColor: colors.text,
    borderRadius: radius.full,
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonText: { color: colors.background, fontSize: 18, fontWeight: "700" },
  controls: {
    flexDirection: "row",
    justifyContent: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  control: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    minWidth: 96,
    alignItems: "center",
  },
  controlActive: { backgroundColor: colors.surfaceRaised },
  controlDanger: { borderColor: colors.danger },
  controlText: { color: colors.text, fontSize: 14, fontWeight: "500" },
});
