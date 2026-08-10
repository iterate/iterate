// Capture screenshots into the project and search them. "Capture" picks from
// the photo library (PHPicker shows the Screenshots album; no permission, no
// native module — ships OTA). Per image: sha256 the payload, skip if the
// /screenshots stream already has that idempotency key, upload bytes to
// itx.files, then one capabilityHost.runScript call does
// toMarkdown → tag → append server-side (lib/screenshots.ts builds the
// script and owns the taxonomy). The list is the stream, kept live; search
// is client-side over the vision-model descriptions.

import { useMutation, useQuery } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { base64ToUint8Array, pickImages } from "../../../lib/attachments.ts";
import { getProjectItx } from "../../../lib/itx.ts";
import {
  buildCaptureScript,
  deriveScreenshotList,
  filterScreenshots,
  readAllScreenshotEvents,
  SCREENSHOT_CAPTURED_EVENT_TYPE,
  SCREENSHOT_TAGS,
  screenshotFilePath,
  screenshotIdempotencyKey,
  SCREENSHOTS_STREAM_PATH,
  type ScreenshotListItem,
} from "../../../lib/screenshots.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";
import { useLiveEvents } from "../../../lib/use-live-events.ts";

const EVENT_TYPES = [SCREENSHOT_CAPTURED_EVENT_TYPE];

export default function ScreenshotsScreen() {
  const { projectId, slug } = useLocalSearchParams<{ projectId: string; slug?: string }>();
  const [query, setQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const server = useQuery({
    queryKey: ["server"],
    queryFn: async () => (await getServerBaseUrl()) || DEFAULT_SERVER,
    staleTime: Infinity,
  });
  const baseUrl = server.data;

  const events = useLiveEvents({
    queryKey: ["screenshot-events", baseUrl || "pending", projectId],
    read: async () => {
      const project = await getProjectItx(baseUrl!, projectId);
      return await readAllScreenshotEvents(project.streams.get(SCREENSHOTS_STREAM_PATH));
    },
    enabled: baseUrl !== undefined,
    eventTypes: EVENT_TYPES,
    projectId,
    streamPath: SCREENSHOTS_STREAM_PATH,
  });

  const capture = useMutation({
    mutationFn: async () => {
      const picked = await pickImages({ selectionLimit: 20 });
      if (picked.length === 0) return { captured: 0, skipped: 0 };
      setProgress({ done: 0, total: picked.length });
      const project = await getProjectItx(baseUrl!, projectId);
      const stream = project.streams.get(SCREENSHOTS_STREAM_PATH);
      let captured = 0;
      let skipped = 0;
      try {
        for (const image of picked) {
          const stableKey = await Crypto.digestStringAsync(
            Crypto.CryptoDigestAlgorithm.SHA256,
            image.base64,
          );
          const idempotencyKey = screenshotIdempotencyKey(stableKey);
          if (await stream.getEvent({ idempotencyKey })) {
            skipped += 1;
          } else {
            await project.files.get(screenshotFilePath(stableKey, image.filename)).put({
              data: base64ToUint8Array(image.base64),
              contentType: image.contentType,
            });
            await project.capabilityHost.runScript(
              buildCaptureScript({
                stableKey,
                filename: image.filename,
                contentType: image.contentType,
                width: image.width,
                height: image.height,
              }),
            );
            captured += 1;
          }
          setProgress((current) => current && { ...current, done: current.done + 1 });
        }
      } finally {
        setProgress(null);
      }
      return { captured, skipped };
    },
  });

  const items = deriveScreenshotList(events.data || []);
  const visible = filterScreenshots(items, query, selectedTags);
  // Chips: taxonomy order first, then novel model-coined tags actually in use.
  const tagsInUse = new Set(items.flatMap((item) => item.payload.tags));
  const chipTags = [
    ...SCREENSHOT_TAGS.map(({ tag }) => tag).filter((tag) => tagsInUse.has(tag)),
    ...[...tagsInUse]
      .filter((tag) => !SCREENSHOT_TAGS.some(({ tag: known }) => known === tag))
      .sort(),
  ];

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: slug ? `${slug} screenshots` : "Screenshots" }} />
      <View style={styles.toolbar}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search descriptions…"
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
          <Text style={styles.captureText}>
            {progress ? `${progress.done}/${progress.total}…` : "+ Capture"}
          </Text>
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
      {capture.isSuccess && capture.data.skipped > 0 ? (
        <Text style={styles.notice}>
          {capture.data.skipped} already captured (skipped), {capture.data.captured} new
        </Text>
      ) : null}
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
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No screenshots yet</Text>
          <Text style={styles.emptyBody}>
            Capture some — each gets described by a vision model and auto-tagged, then you can
            search them here by what they show.
          </Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => String(item.offset)}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          renderItem={({ item }) => (
            <ScreenshotRow baseUrl={baseUrl!} item={item} projectId={projectId} />
          )}
        />
      )}
    </View>
  );
}

function ScreenshotRow({
  baseUrl,
  item,
  projectId,
}: {
  baseUrl: string;
  item: ScreenshotListItem;
  projectId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const thumbnail = useQuery({
    queryKey: ["screenshot-url", projectId, item.payload.path],
    queryFn: async () => {
      const project = await getProjectItx(baseUrl, projectId);
      return await project.files.get(item.payload.path).url();
    },
    staleTime: Infinity,
  });

  return (
    <Pressable onPress={() => setExpanded(!expanded)} style={styles.row}>
      {thumbnail.data ? (
        <Image source={{ uri: thumbnail.data }} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder]} />
      )}
      <View style={styles.rowBody}>
        <Text numberOfLines={expanded ? undefined : 3} style={styles.markdown}>
          {item.payload.markdown || "(no description)"}
        </Text>
        <View style={styles.rowTags}>
          {item.payload.tags.map((tag) => (
            <Text key={tag} style={styles.rowTag}>
              {tag}
            </Text>
          ))}
          <Text style={styles.rowDate}>{new Date(item.capturedAt).toLocaleDateString()}</Text>
        </View>
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
  notice: { color: colors.textMuted, fontSize: 12, paddingHorizontal: spacing.md, paddingTop: 4 },
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
  thumb: { borderRadius: radius.sm, height: 96, width: 54 },
  thumbPlaceholder: { backgroundColor: colors.border },
  rowBody: { flex: 1, gap: spacing.xs },
  markdown: { color: colors.text, fontSize: 13, lineHeight: 18 },
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
});
