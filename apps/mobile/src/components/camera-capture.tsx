// Full-screen camera capture, reached from the attachment sheet's live
// camera tile: snap a photo (shutter) or record a clip (red button toggles).
// The picker hides once a filter is selected; with a filter active the plain
// expo-camera preview swaps for the platform filter camera, with the
// effect baked into its captured photos and videos.
// Produces a ComposerAttachment; nothing sends until the composer's ↑.
//
import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useGlobalSearchParams } from "expo-router";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { CameraView } from "expo-camera";
import * as FileSystem from "expo-file-system/legacy";
import { saveFilteredVideo } from "../lib/filter-video.ts";
import { useCameraFacing } from "../lib/camera-facing.ts";
import { getProjectItx } from "../lib/itx.ts";
import { DEFAULT_SERVER } from "../lib/servers.ts";
import { getServerBaseUrl } from "../lib/storage.ts";
import { formatClipDuration, type ComposerAttachment } from "../lib/composer-attachments.ts";
import { FILTER_PICKER } from "../lib/filters/picker.ts";
import { colors, radius, spacing } from "../lib/theme.ts";
// eslint-disable-next-line import/extensions -- Metro selects the .ios.tsx implementation; explicit extensions bypass platform selection.
import FilterCamera from "./filter-camera-view";
import type { FilterCameraCommand, FilterVideo } from "./filter-camera-types.ts";

export function CameraCaptureModal(props: {
  visible: boolean;
  onClose: () => void;
  onCapture: (attachment: ComposerAttachment) => void;
}) {
  const ref = useRef<CameraView>(null);
  // A canceled capture must not attach after native recording or cache
  // persistence finishes. Each operation owns its cancellation signal.
  const captureAbort = useRef<AbortController | null>(null);
  const { facing, setFacing } = useCameraFacing();
  // Project-authored filters: filters/<name>.filter.js files in any of the
  // project's repos, fetched here (native side holds the session) and
  // evaluated inside the platform filter engine. Ask iterate to write
  // one and it shows up in the ✨ picker.
  const { projectId } = useGlobalSearchParams<{ projectId?: string }>();
  const dynamicFilters = useQuery({
    queryKey: ["camera-dynamic-filters", projectId],
    enabled: props.visible && typeof projectId === "string",
    staleTime: 60_000,
    queryFn: async () => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const project = await getProjectItx(baseUrl, projectId!);
      const repos: { path: string }[] = await project.repos.list();
      const found: { id: string; label: string; emoji: string; source: string }[] = [];
      for (const { path: repoPath } of repos) {
        const repo = project.repos.get(repoPath);
        const { paths } = await repo.listFiles();
        for (const path of paths) {
          if (!/(^|\/)filters\/[^/]+\.filter\.js$/.test(path)) continue;
          const file = await repo.readFile({ path });
          if (!file?.content) continue;
          // Metadata is regex-sniffed natively (the picker needs chips
          // before the filter engine starts); the engine does the real eval.
          const slug = path
            .split("/")
            .pop()!
            .replace(/\.filter\.js$/, "");
          found.push({
            id: `project:${repoPath}:${slug}`,
            label: /label:\s*"([^"]+)"/.exec(file.content)?.[1] || slug,
            emoji: /emoji:\s*"([^"]+)"/.exec(file.content)?.[1] || "🧪",
            source: file.content,
          });
        }
      }
      return found;
    },
  });
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [filterId, setFilterId] = useState<string | null>(null);
  const [filterCommand, setFilterCommand] = useState<FilterCameraCommand | null>(null);
  // Bridges between the imperative mutations below and the filter pipeline's
  // async result props: the mutation parks a promise here, the matching
  // onPhoto/onVideo prop settles it.
  const pendingFilterPhoto = useRef<{
    resolve: (photo: { base64: string; width: number; height: number }) => void;
    reject: (error: Error) => void;
  } | null>(null);
  const pendingFilterVideo = useRef<{
    resolve: (video: FilterVideo) => void;
    reject: (error: Error) => void;
  } | null>(null);
  const insets = useSafeAreaInsets();

  const commandSequence = useRef(0);
  const sendFilterCommand = (type: FilterCameraCommand["type"]) => {
    setFilterCommand({ seq: ++commandSequence.current, type });
  };

  const snap = useMutation({
    mutationFn: async () => {
      const now = Date.now();
      const abort = new AbortController();
      captureAbort.current = abort;
      if (filterId !== null) {
        const photo = await new Promise<{ base64: string; width: number; height: number }>(
          (resolve, reject) => {
            pendingFilterPhoto.current = { resolve, reject };
            sendFilterCommand("snap");
          },
        );
        if (abort.signal.aborted) return;
        props.onCapture({
          kind: "photo",
          image: {
            assetId: null,
            filename: `filter-${now}.jpg`,
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
      if (abort.signal.aborted) return;
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
      const abort = new AbortController();
      captureAbort.current = abort;
      setRecordingStartedAt(Date.now());
      if (filterId !== null) {
        const video = await new Promise<FilterVideo>((resolve, reject) => {
          pendingFilterVideo.current = { resolve, reject };
          sendFilterCommand("start-recording");
        });
        const attachment = await saveFilteredVideo({
          video,
          capturedAt: Date.now(),
          signal: abort.signal,
          fileSystem: FileSystem,
        });
        if (!attachment) return;
        props.onCapture(attachment);
        props.onClose();
        return;
      }
      // Resolves when stopRecording() is called (or maxDuration hits).
      const video = await ref.current!.recordAsync({ maxDuration: 60 });
      if (abort.signal.aborted) return;
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
    setFilterCommand(null);
    captureAbort.current?.abort();
    pendingFilterPhoto.current?.reject(new Error("Photo capture canceled"));
    pendingFilterPhoto.current = null;
    if (record.isPending) {
      if (filterId !== null) {
        // Settle the parked promise so the mutation ends; cancellation above
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
              dynamicFilters={(dynamicFilters.data || []).map(({ id, source }) => ({ id, source }))}
              facing={facing}
              filterId={filterId}
              onCaptureError={async (message) => {
                setFilterCommand(null);
                const error = new Error(message);
                pendingFilterPhoto.current?.reject(error);
                pendingFilterPhoto.current = null;
                pendingFilterVideo.current?.reject(error);
                pendingFilterVideo.current = null;
              }}
              onPhoto={async (photo) => {
                setFilterCommand(null);
                pendingFilterPhoto.current?.resolve(photo);
                pendingFilterPhoto.current = null;
              }}
              onVideo={async (video) => {
                setFilterCommand(null);
                if (!pendingFilterVideo.current && "uri" in video) {
                  await FileSystem.deleteAsync(video.uri, { idempotent: true });
                }
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
              <Text style={styles.timerText}>{formatClipDuration(elapsedSeconds)}</Text>
            </View>
          ) : null}
        </View>
        {snap.isError || record.isError ? (
          <Text style={styles.error}>
            {String(((snap.error || record.error) as Error).message)}
          </Text>
        ) : null}
        {filterId ? null : (
          <ScrollView
            contentContainerStyle={styles.pickerContent}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.picker, { bottom: insets.bottom + 120 }]}
          >
            {[null, ...FILTER_PICKER, ...(dynamicFilters.data || [])].map((filter) => {
              const id = filter ? filter.id : null;
              const selected = filterId === id;
              return (
                <Pressable
                  accessibilityLabel={filter ? `${filter.label} filter` : "No filter"}
                  accessibilityRole="button"
                  disabled={snap.isPending || record.isPending}
                  key={id || "none"}
                  onPress={() => {
                    setFilterCommand(null);
                    setFilterId(id);
                  }}
                  style={[styles.filterChip, selected && styles.filterChipSelected]}
                >
                  <Text style={styles.filterChipEmoji}>{filter ? filter.emoji : "🚫"}</Text>
                  <Text style={styles.filterChipLabel}>{filter ? filter.label : "None"}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + spacing.lg }]}>
          <Pressable
            accessibilityLabel="Flip camera"
            accessibilityRole="button"
            disabled={snap.isPending || record.isPending}
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
