// Full-screen camera capture, reached from the attachment sheet's live
// camera tile: snap a photo (shutter) or record a clip (red button toggles).
// Produces a ComposerAttachment; nothing sends until the composer's ↑.
//
// Only mounted when expo-camera loaded (lib/native-modules.ts) — the sheet
// hides the tile otherwise — so the hooks in here can use the module
// directly.

import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { CameraView as CameraViewType } from "expo-camera";
import { formatClipDuration, type ComposerAttachment } from "../lib/composer-attachments.ts";
import { loadCamera } from "../lib/native-modules.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

export function CameraCaptureModal(props: {
  visible: boolean;
  onClose: () => void;
  onCapture: (attachment: ComposerAttachment) => void;
}) {
  const camera = loadCamera()!;
  const CameraView = camera.CameraView;
  const ref = useRef<CameraViewType>(null);
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const insets = useSafeAreaInsets();

  const snap = useMutation({
    mutationFn: async () => {
      const photo = await ref.current!.takePictureAsync({ quality: 0.8, base64: true });
      if (!photo.base64) throw new Error("The camera returned no bytes");
      const now = Date.now();
      props.onCapture({
        kind: "photo",
        image: {
          assetId: null,
          filename: `camera-${now}.jpg`,
          contentType: "image/jpeg",
          base64: photo.base64,
          previewUri: photo.uri,
          width: photo.width,
          height: photo.height,
        },
      });
      props.onClose();
    },
  });

  const record = useMutation({
    mutationFn: async () => {
      setRecordingStartedAt(Date.now());
      // Resolves when stopRecording() is called (or maxDuration hits).
      const video = await ref.current!.recordAsync({ maxDuration: 60 });
      if (!video) throw new Error("The camera returned no recording");
      const now = Date.now();
      props.onCapture({
        kind: "video",
        assetId: null,
        filename: `camera-${now}.mov`,
        contentType: "video/quicktime",
        uri: video.uri,
        previewUri: null,
        durationSeconds: null,
        sizeBytes: null,
      });
      props.onClose();
    },
    onSettled: () => setRecordingStartedAt(null),
  });

  // The elapsed indicator without an effect/interval hook: a query that
  // refetches while recording (precedent: query-cache-driven UI everywhere
  // in this app).
  const clock = useQuery({
    queryKey: ["camera-capture-clock"],
    queryFn: async () => Date.now(),
    refetchInterval: recordingStartedAt === null ? false : 500,
    enabled: recordingStartedAt !== null,
  });
  const elapsedSeconds =
    recordingStartedAt === null
      ? 0
      : ((clock.data || recordingStartedAt) - recordingStartedAt) / 1000;

  return (
    <Modal
      animationType="slide"
      onRequestClose={props.onClose}
      presentationStyle="fullScreen"
      visible={props.visible}
    >
      <View style={styles.screen}>
        <CameraView facing={facing} mode="video" ref={ref} style={StyleSheet.absoluteFill} />
        <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
          <Pressable
            accessibilityLabel="Close camera"
            accessibilityRole="button"
            hitSlop={12}
            onPress={props.onClose}
            style={styles.roundControl}
          >
            <Ionicons name="close" size={22} color={colors.text} />
          </Pressable>
          {recordingStartedAt !== null ? (
            <View style={styles.recordingPill}>
              <View style={styles.redDot} />
              <Text style={styles.timerText}>{formatClipDuration(elapsedSeconds)}</Text>
            </View>
          ) : null}
        </View>
        {snap.isError || record.isError ? (
          <Text style={styles.error}>
            {String(((snap.error || record.error) as Error).message)}
          </Text>
        ) : null}
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + spacing.lg }]}>
          <Pressable
            accessibilityLabel="Flip camera"
            accessibilityRole="button"
            disabled={record.isPending}
            onPress={() => setFacing(facing === "back" ? "front" : "back")}
            style={styles.roundControl}
          >
            <Ionicons name="camera-reverse-outline" size={24} color={colors.text} />
          </Pressable>
          <Pressable
            accessibilityLabel="Take photo"
            accessibilityRole="button"
            disabled={snap.isPending || record.isPending}
            onPress={() => snap.mutate()}
            style={styles.shutter}
          >
            <View style={styles.shutterInner} />
          </Pressable>
          <Pressable
            accessibilityLabel={record.isPending ? "Stop recording" : "Record video"}
            accessibilityRole="button"
            disabled={snap.isPending}
            onPress={() => {
              if (record.isPending) {
                ref.current!.stopRecording();
              } else {
                record.mutate();
              }
            }}
            style={[styles.roundControl, record.isPending && styles.recordingControl]}
          >
            <Ionicons
              name={record.isPending ? "stop" : "videocam"}
              size={24}
              color={record.isPending ? colors.background : colors.danger}
            />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
  },
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-evenly",
  },
  roundControl: {
    width: 52,
    height: 52,
    borderRadius: radius.full,
    backgroundColor: "#0b0b0f99",
    alignItems: "center",
    justifyContent: "center",
  },
  recordingControl: { backgroundColor: colors.danger },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: radius.full,
    borderColor: colors.text,
    borderWidth: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {
    width: 60,
    height: 60,
    borderRadius: radius.full,
    backgroundColor: colors.text,
  },
  recordingPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: "#0b0b0f99",
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  redDot: {
    width: 10,
    height: 10,
    borderRadius: radius.full,
    backgroundColor: colors.danger,
  },
  timerText: { color: colors.text, fontSize: 13, fontVariant: ["tabular-nums"] },
  error: {
    color: colors.danger,
    fontSize: 13,
    textAlign: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
});
