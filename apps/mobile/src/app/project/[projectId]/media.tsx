// Capture screenshots and photos into the project and search them by what
// they show. "Add" picks from the photo library (PHPicker — no permission,
// no native module, ships OTA). Per image: sha256 the payload, skip if the
// /media stream already has that idempotency key, upload bytes to itx.files,
// then one capabilityHost.runScript call does
// toMarkdown → vision transcript+tags → append server-side (lib/media.ts
// builds the script and owns the taxonomy). Picked items appear immediately
// as pending cards (three at a time in flight) and resolve into real rows as
// their events land on the live stream. Tap a thumbnail for full screen;
// "Re-analyze" reruns the pipeline and overlays the newest result.

import { useMutation, useQuery } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { base64ToUint8Array, pickImages, type PickedImage } from "../../../lib/attachments.ts";
import { getProjectItx } from "../../../lib/itx.ts";
import {
  buildProcessScript,
  deriveMediaList,
  filterMedia,
  mapWithConcurrency,
  MEDIA_EVENT_TYPES,
  MEDIA_STREAM_PATH,
  MEDIA_TAGS,
  mediaFilePath,
  mediaIdempotencyKey,
  readAllMediaEvents,
  type MediaListItem,
} from "../../../lib/media.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";
import { useLiveEvents } from "../../../lib/use-live-events.ts";

type PendingItem = {
  previewUri: string;
  filename: string;
  status: "waiting" | "analyzing" | "skipped" | "error";
  error?: string;
};

export default function MediaScreen() {
  const { projectId, slug } = useLocalSearchParams<{ projectId: string; slug?: string }>();
  const [query, setQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [viewerUri, setViewerUri] = useState<string | null>(null);

  const server = useQuery({
    queryKey: ["server"],
    queryFn: async () => (await getServerBaseUrl()) || DEFAULT_SERVER,
    staleTime: Infinity,
  });
  const baseUrl = server.data;

  const events = useLiveEvents({
    queryKey: ["media-events", baseUrl || "pending", projectId],
    read: async () => {
      const project = await getProjectItx(baseUrl!, projectId);
      return await readAllMediaEvents(project.streams.get(MEDIA_STREAM_PATH));
    },
    enabled: baseUrl !== undefined,
    eventTypes: MEDIA_EVENT_TYPES,
    projectId,
    streamPath: MEDIA_STREAM_PATH,
  });

  const capture = useMutation({
    mutationFn: async () => {
      const picked = await pickImages({ selectionLimit: 20 });
      if (picked.length === 0) return;
      // Every picked image shows immediately; statuses update per item as
      // the three-wide pipeline works through them.
      setPending(
        picked.map((image) => ({
          previewUri: image.previewUri,
          filename: image.filename,
          status: "waiting" as const,
        })),
      );
      const setStatus = (image: PickedImage, status: PendingItem["status"], error?: string) =>
        setPending((current) =>
          current.map((row) =>
            row.previewUri === image.previewUri ? { ...row, status, error } : row,
          ),
        );
      const project = await getProjectItx(baseUrl!, projectId);
      const stream = project.streams.get(MEDIA_STREAM_PATH);
      await mapWithConcurrency(picked, 3, async (image) => {
        try {
          setStatus(image, "analyzing");
          const stableKey = await Crypto.digestStringAsync(
            Crypto.CryptoDigestAlgorithm.SHA256,
            image.base64,
          );
          if (await stream.getEvent({ idempotencyKey: mediaIdempotencyKey(stableKey) })) {
            setStatus(image, "skipped");
            return;
          }
          await project.files.get(mediaFilePath(stableKey, image.filename)).put({
            data: base64ToUint8Array(image.base64),
            contentType: image.contentType,
          });
          await project.capabilityHost.runScript(
            buildProcessScript({
              stableKey,
              filename: image.filename,
              contentType: image.contentType,
              width: image.width,
              height: image.height,
              mode: "capture",
            }),
          );
          // The captured event arrives over the live connection and renders
          // as a real row; drop the pending card.
          setPending((current) => current.filter((row) => row.previewUri !== image.previewUri));
        } catch (error) {
          setStatus(image, "error", error instanceof Error ? error.message : String(error));
        }
      });
      // Skipped/errored cards stay visible until the next capture starts.
    },
  });

  const items = deriveMediaList(events.data || []);
  const visible = filterMedia(items, query, selectedTags);
  // Chips: taxonomy order first, then novel model-coined tags actually in use.
  const tagsInUse = new Set(items.flatMap((item) => item.payload.tags));
  const chipTags = [
    ...MEDIA_TAGS.map(({ tag }) => tag).filter((tag) => tagsInUse.has(tag)),
    ...[...tagsInUse].filter((tag) => !MEDIA_TAGS.some(({ tag: known }) => known === tag)).sort(),
  ];

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: slug ? `${slug} media` : "Media" }} />
      <View style={styles.toolbar}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search descriptions and text…"
          placeholderTextColor={colors.textFaint}
          style={styles.search}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          accessibilityRole="button"
          onPress={() => capture.mutate()}
          disabled={capture.isPending || baseUrl === undefined}
          style={[styles.captureButton, capture.isPending && styles.captureDisabled]}
        >
          <Text style={styles.captureText}>+ Add</Text>
        </Pressable>
      </View>
      {chipTags.length > 0 ? (
        <View style={styles.chips}>
          {chipTags.map((tag) => {
            const selected = selectedTags.includes(tag);
            return (
              <Pressable
                key={tag}
                onPress={() =>
                  setSelectedTags(
                    selected ? selectedTags.filter((t) => t !== tag) : [...selectedTags, tag],
                  )
                }
                style={[styles.chip, selected && styles.chipSelected]}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{tag}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {capture.isError ? <Text style={styles.error}>{String(capture.error.message)}</Text> : null}
      {events.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} />
        </View>
      ) : events.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>{String(events.error.message)}</Text>
          <Pressable onPress={() => void events.refetch()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : items.length === 0 && pending.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Nothing here yet</Text>
          <Text style={styles.emptyBody}>
            Add screenshots or photos — each gets described and transcribed by a vision model, then
            you can search them here by what they show.
          </Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => String(item.offset)}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          ListHeaderComponent={
            pending.length > 0 ? (
              <View style={{ gap: spacing.sm, marginBottom: spacing.sm }}>
                {pending.map((row) => (
                  <PendingRow key={row.previewUri} row={row} />
                ))}
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <MediaRow
              baseUrl={baseUrl!}
              item={item}
              onViewImage={setViewerUri}
              projectId={projectId}
            />
          )}
        />
      )}
      <Modal
        animationType="fade"
        onRequestClose={() => setViewerUri(null)}
        statusBarTranslucent
        transparent
        visible={viewerUri !== null}
      >
        <Pressable
          accessibilityLabel="Close image"
          onPress={() => setViewerUri(null)}
          style={styles.viewer}
        >
          {viewerUri ? (
            <Image resizeMode="contain" source={{ uri: viewerUri }} style={styles.viewerImage} />
          ) : null}
        </Pressable>
      </Modal>
    </View>
  );
}

function PendingRow({ row }: { row: PendingItem }) {
  return (
    <View style={[styles.row, row.status === "error" && styles.rowError]}>
      <Image source={{ uri: row.previewUri }} style={styles.thumb} />
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={styles.pendingFilename}>
          {row.filename}
        </Text>
        {row.status === "error" ? (
          <Text numberOfLines={3} style={styles.pendingError}>
            {row.error}
          </Text>
        ) : row.status === "skipped" ? (
          <Text style={styles.pendingStatus}>Already captured — skipped</Text>
        ) : (
          <View style={styles.pendingSpinnerRow}>
            <ActivityIndicator color={colors.textMuted} size="small" />
            <Text style={styles.pendingStatus}>
              {row.status === "waiting" ? "Waiting…" : "Analyzing…"}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

function MediaRow({
  baseUrl,
  item,
  onViewImage,
  projectId,
}: {
  baseUrl: string;
  item: MediaListItem;
  onViewImage: (uri: string) => void;
  projectId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const imageUrl = useQuery({
    queryKey: ["media-url", projectId, item.payload.path],
    queryFn: async () => {
      const project = await getProjectItx(baseUrl, projectId);
      return await project.files.get(item.payload.path).url();
    },
    staleTime: Infinity,
  });
  const reanalyze = useMutation({
    mutationFn: async () => {
      const project = await getProjectItx(baseUrl, projectId);
      await project.capabilityHost.runScript(
        buildProcessScript({
          stableKey: item.payload.stableKey,
          filename: item.payload.filename,
          contentType: item.payload.contentType,
          width: item.payload.width,
          height: item.payload.height,
          mode: { reprocessNonce: Date.now().toString(36) },
        }),
      );
      // The processed event arrives over the live stream and re-renders the
      // row through deriveMediaList — nothing to invalidate here.
    },
  });

  return (
    <Pressable onPress={() => setExpanded(!expanded)} style={styles.row}>
      <Pressable
        accessibilityLabel="View full screen"
        disabled={imageUrl.data === undefined}
        onPress={() => imageUrl.data && onViewImage(imageUrl.data)}
      >
        {imageUrl.data ? (
          <Image source={{ uri: imageUrl.data }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.thumbPlaceholder]} />
        )}
      </Pressable>
      <View style={styles.rowBody}>
        <Text numberOfLines={expanded ? undefined : 3} style={styles.markdown}>
          {item.payload.markdown || "(no description)"}
        </Text>
        {expanded && item.payload.transcript ? (
          <Text selectable style={styles.transcript}>
            {item.payload.transcript}
          </Text>
        ) : null}
        <View style={styles.rowTags}>
          {item.payload.tags.map((tag) => (
            <Text key={tag} style={styles.rowTag}>
              {tag}
            </Text>
          ))}
          <Text style={styles.rowDate}>{new Date(item.capturedAt).toLocaleDateString()}</Text>
        </View>
        {expanded ? (
          <Pressable
            accessibilityRole="button"
            disabled={reanalyze.isPending}
            onPress={() => reanalyze.mutate()}
            style={[styles.reanalyze, reanalyze.isPending && styles.captureDisabled]}
          >
            <Text style={styles.reanalyzeText}>
              {reanalyze.isPending ? "Re-analyzing…" : "Re-analyze"}
            </Text>
          </Pressable>
        ) : null}
        {reanalyze.isError ? (
          <Text style={styles.pendingError}>{String(reanalyze.error.message)}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  toolbar: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  search: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.text,
    flex: 1,
    fontSize: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  captureButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  captureDisabled: { opacity: 0.5 },
  captureText: { color: colors.background, fontSize: 14, fontWeight: "600" },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  chip: {
    borderColor: colors.border,
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  chipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.textMuted, fontSize: 12 },
  chipTextSelected: { color: colors.background, fontWeight: "600" },
  center: { alignItems: "center", flex: 1, justifyContent: "center", padding: spacing.xl },
  error: { color: colors.danger, fontSize: 13, padding: spacing.md },
  retry: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
  },
  retryText: { color: colors.text, fontSize: 14 },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  emptyBody: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: spacing.sm,
    textAlign: "center",
  },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.md,
  },
  rowError: { borderColor: colors.danger },
  thumb: { borderRadius: radius.sm, height: 96, width: 54 },
  thumbPlaceholder: { backgroundColor: colors.border },
  rowBody: { flex: 1, gap: spacing.xs },
  markdown: { color: colors.text, fontSize: 13, lineHeight: 18 },
  transcript: {
    borderLeftColor: colors.border,
    borderLeftWidth: 2,
    color: colors.textMuted,
    fontFamily: "Menlo",
    fontSize: 11,
    lineHeight: 15,
    paddingLeft: spacing.sm,
  },
  rowTags: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  rowTag: {
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    color: colors.textMuted,
    fontSize: 11,
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  rowDate: { color: colors.textFaint, fontSize: 11, marginLeft: "auto" },
  pendingFilename: { color: colors.text, fontSize: 13, fontWeight: "500" },
  pendingSpinnerRow: { alignItems: "center", flexDirection: "row", gap: spacing.sm },
  pendingStatus: { color: colors.textMuted, fontSize: 12 },
  pendingError: { color: colors.danger, fontSize: 12 },
  reanalyze: {
    alignSelf: "flex-start",
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  reanalyzeText: { color: colors.textMuted, fontSize: 12, fontWeight: "500" },
  viewer: {
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.92)",
    flex: 1,
    justifyContent: "center",
  },
  viewerImage: { height: "100%", width: "100%" },
});
