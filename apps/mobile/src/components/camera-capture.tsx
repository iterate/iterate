// Full-screen camera capture, reached from the attachment sheet's live
// camera tile: snap a photo (shutter) or record a clip (red button toggles).
// The ✨ button opens a filter picker; with a filter active the plain
// expo-camera preview swaps for the WebView filter pipeline
// (filter-camera.tsx) and captures round-trip through it, filter baked in.
// Produces a ComposerAttachment; nothing sends until the composer's ↑.
//
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { CameraView } from "expo-camera";
import * as FileSystem from "expo-file-system/legacy";
import { formatClipDuration, type ComposerAttachment } from "../lib/composer-attachments.ts";
import { FILTER_PICKER, FILTERED_CLIP_MAX_SECONDS } from "../lib/filters/picker.ts";
import { colors, radius, spacing } from "../lib/theme.ts";
import FilterCamera, { type FilterCameraCommand } from "./filter-camera.tsx";

const CAMERA_FACING_KEY = "iterate.cameraFacing.v1";

export function CameraCaptureModal(props: {
  visible: boolean;
  onClose: () => void;
  onCapture: (attachment: ComposerAttachment) => void;
}) {
  const ref = useRef<CameraView>(null);
  // Closing mid-recording must NOT attach the clip: unmounting the camera
  // resolves recordAsync with the partial video, so without this flag the
  // aborted recording would ride into the composer (review-caught).
  const closeCancelledRecording = useRef(false);
  const queryClient = useQueryClient();
  // Which camera you last used survives app restarts (a flip writes through
  // to AsyncStorage; the query seeds from it).
  const storedFacing = useQuery({
    queryKey: ["camera-facing"],
    queryFn: async () =>
      ((await AsyncStorage.getItem(CAMERA_FACING_KEY)) === "front" ? "front" : "back") as
        | "back"
        | "front",
  });
  const facing = storedFacing.data || "back";
  const setFacing = (next: "back" | "front") => {
    queryClient.setQueryData(["camera-facing"], next);
    void AsyncStorage.setItem(CAMERA_FACING_KEY, next);
  };
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [filterId, setFilterId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filterCommand, setFilterCommand] = useState<FilterCameraCommand | null>(null);
  // Bridges between the imperative mutations below and the filter pipeline's
  // async result props: the mutation parks a promise here, the matching
  // onPhoto/onVideo prop settles it.
  const pendingFilterPhoto = useRef<{
    resolve: (photo: { base64: string; width: number; height: number }) => void;
    reject: (error: Error) => void;
  } | null>(null);
  const pendingFilterVideo = useRef<{
    resolve: (video: { base64: string; mimeType: string; durationSeconds: number }) => void;
    reject: (error: Error) => void;
  } | null>(null);
  const insets = useSafeAreaInsets();

  const sendFilterCommand = (type: FilterCameraCommand["type"]) => {
    setFilterCommand({ seq: (filterCommand?.seq || 0) + 1, type });
  };

  const snap = useMutation({
    mutationFn: async () => {
      const now = Date.now();
      if (filterId !== null) {
        const photo = await new Promise<{ base64: string; width: number; height: number }>(
          (resolve, reject) => {
            pendingFilterPhoto.current = { resolve, reject };
            sendFilterCommand("snap");
          },
        );
        props.onCapture({
          kind: "photo",
          image: {
            assetId: null,
            filename: `filter-${filterId}-${now}.jpg`,
            contentType: "image/jpeg",
            base64: photo.base64,
            previewUri: `data:image/jpeg;base64,${photo.base64}`,
            width: photo.width,
            height: photo.height,
          },
        });
        props.onClose();
        return;
      }
      const photo = await ref.current!.takePictureAsync({ quality: 0.8, base64: true });
      if (!photo.base64) throw new Error("The camera returned no bytes");
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
      closeCancelledRecording.current = false;
      setRecordingStartedAt(Date.now());
      if (filterId !== null) {
        const video = await new Promise<{
          base64: string;
          mimeType: string;
          durationSeconds: number;
        }>((resolve, reject) => {
          pendingFilterVideo.current = { resolve, reject };
          sendFilterCommand("start-recording");
        });
        if (closeCancelledRecording.current) return;
        const extension = video.mimeType.startsWith("video/mp4") ? "mp4" : "webm";
        const now = Date.now();
        const uri = `${FileSystem.cacheDirectory}filter-${filterId}-${now}.${extension}`;
        await FileSystem.writeAsStringAsync(uri, video.base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        props.onCapture({
          kind: "video",
          assetId: null,
          filename: `filter-${filterId}-${now}.${extension}`,
          contentType: video.mimeType.split(";")[0],
          uri,
          previewUri: null,
          durationSeconds: video.durationSeconds,
          sizeBytes: null,
          width: null,
          height: null,
        });
        props.onClose();
        return;
      }
      // Resolves when stopRecording() is called (or maxDuration hits).
      const video = await ref.current!.recordAsync({ maxDuration: 60 });
      if (closeCancelledRecording.current) return;
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
        width: null,
        height: null,
      });
      props.onClose();
    },
    onSettled: () => setRecordingStartedAt(null),
  });

  const stopRecording = () => {
    if (filterId !== null) {
      sendFilterCommand("stop-recording");
    } else {
      ref.current!.stopRecording();
    }
  };

  const close = () => {
    if (record.isPending) {
      closeCancelledRecording.current = true;
      if (filterId !== null) {
        // Settle the parked promise so the mutation ends; the flag above
        // stops the clip from attaching.
        pendingFilterVideo.current?.resolve({
          base64: "",
          mimeType: "video/mp4",
          durationSeconds: 0,
        });
        pendingFilterVideo.current = null;
      } else {
        ref.current?.stopRecording();
      }
    }
    props.onClose();
  };

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
      onRequestClose={close}
      presentationStyle="fullScreen"
      visible={props.visible}
    >
      <View style={styles.screen}>
        {filterId === null ? (
          <CameraView facing={facing} mode="video" ref={ref} style={StyleSheet.absoluteFill} />
        ) : (
          <View style={StyleSheet.absoluteFill}>
            <FilterCamera
              command={filterCommand}
              dom={{
                style: { flex: 1 },
                scrollEnabled: false,
                allowsInlineMediaPlayback: true,
                mediaPlaybackRequiresUserAction: false,
                mediaCapturePermissionGrantType: "grant",
              }}
              facing={facing}
              filterId={filterId}
              onCaptureError={async (message) => {
                const error = new Error(message);
                pendingFilterPhoto.current?.reject(error);
                pendingFilterPhoto.current = null;
                pendingFilterVideo.current?.reject(error);
                pendingFilterVideo.current = null;
              }}
              onPhoto={async (photo) => {
                pendingFilterPhoto.current?.resolve(photo);
                pendingFilterPhoto.current = null;
              }}
              onVideo={async (video) => {
                pendingFilterVideo.current?.resolve(video);
                pendingFilterVideo.current = null;
              }}
            />
          </View>
        )}
        <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
          <Pressable
            accessibilityLabel="Close camera"
            accessibilityRole="button"
            hitSlop={12}
            onPress={close}
            style={styles.roundControl}
          >
            <Ionicons name="close" size={22} color={colors.text} />
          </Pressable>
          {recordingStartedAt !== null ? (
            <View style={styles.recordingPill}>
              <View style={styles.redDot} />
              <Text style={styles.timerText}>
                {formatClipDuration(elapsedSeconds)}
                {filterId !== null ? ` / ${formatClipDuration(FILTERED_CLIP_MAX_SECONDS)}` : ""}
              </Text>
            </View>
          ) : null}
          <Pressable
            accessibilityLabel="Choose a filter"
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => setPickerOpen(!pickerOpen)}
            style={[styles.roundControl, filterId !== null && styles.activeFilterControl]}
          >
            <Text style={styles.sparkle}>✨</Text>
          </Pressable>
        </View>
        {snap.isError || record.isError ? (
          <Text style={styles.error}>
            {String(((snap.error || record.error) as Error).message)}
          </Text>
        ) : null}
        {pickerOpen ? (
          <ScrollView
            contentContainerStyle={styles.pickerContent}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.picker, { bottom: insets.bottom + 120 }]}
          >
            {[null, ...FILTER_PICKER].map((filter) => {
              const id = filter === null ? null : filter.id;
              const selected = filterId === id;
              return (
                <Pressable
                  accessibilityLabel={filter === null ? "No filter" : `${filter.label} filter`}
                  accessibilityRole="button"
                  disabled={record.isPending}
                  key={id || "none"}
                  onPress={() => {
                    setFilterId(id);
                    setPickerOpen(false);
                  }}
                  style={[styles.filterChip, selected && styles.filterChipSelected]}
                >
                  <Text style={styles.filterChipEmoji}>
                    {filter === null ? "🚫" : filter.emoji}
                  </Text>
                  <Text style={styles.filterChipLabel}>
                    {filter === null ? "None" : filter.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
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
                stopRecording();
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
  activeFilterControl: { borderColor: colors.text, borderWidth: 2 },
  sparkle: { fontSize: 22 },
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
  picker: {
    position: "absolute",
    left: 0,
    right: 0,
    maxHeight: 84,
  },
  pickerContent: {
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: "center",
  },
  filterChip: {
    alignItems: "center",
    backgroundColor: "#0b0b0f99",
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    gap: 2,
  },
  filterChipSelected: { borderColor: colors.text, borderWidth: 2 },
  filterChipEmoji: { fontSize: 26 },
  filterChipLabel: { color: colors.text, fontSize: 11 },
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
