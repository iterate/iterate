// Browse captured notes (grill decision D10): newest first, client-side text
// filter, long-press to delete (a notes/deleted tombstone), tap to expand.
// Rows show the model-derived title once notes/analysis-settled lands (the
// NotesApp processor's obligation), with the text's first line as the
// fallback; photo attachments render as thumbnails and open in the shared
// media viewer. Capture happens in the global composer
// (components/note-composer.tsx), not here.

import { useMutation, useQuery } from "@tanstack/react-query";
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
import { MediaViewer } from "../../../components/media-viewer.tsx";
import { getProjectItx } from "../../../lib/itx.ts";
import {
  buildDeletedEvent,
  buildReanalyzeEvent,
  buildUpdatedEvent,
  deriveNotesList,
  filterNotes,
  NOTE_EVENT_TYPES,
  NOTES_STREAM_PATH,
  readAllNoteEvents,
  type NoteAttachment,
  type NoteListItem,
} from "../../../lib/notes.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";
import { useLiveEvents } from "../../../lib/use-live-events.ts";

export default function NotesScreen() {
  const { projectId, slug } = useLocalSearchParams<{ projectId: string; slug?: string }>();
  const [query, setQuery] = useState("");
  const [viewer, setViewer] = useState<{ uri: string; title: string; markdown: string } | null>(
    null,
  );

  const server = useQuery({
    queryKey: ["server"],
    queryFn: async () => (await getServerBaseUrl()) || DEFAULT_SERVER,
    staleTime: Infinity,
  });
  const baseUrl = server.data;

  const events = useLiveEvents({
    queryKey: ["note-events", baseUrl || "pending", projectId],
    read: async () => {
      const project = await getProjectItx(baseUrl!, projectId);
      return await readAllNoteEvents(project.streams.get(NOTES_STREAM_PATH));
    },
    enabled: baseUrl !== undefined,
    eventTypes: NOTE_EVENT_TYPES,
    projectId,
    streamPath: NOTES_STREAM_PATH,
  });

  const items = deriveNotesList(events.data || []);
  const visible = filterNotes(items, query);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: slug ? `${slug} notes` : "Notes" }} />
      <View style={styles.toolbar}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search notes…"
          placeholderTextColor={colors.textFaint}
          style={styles.search}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
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
          <Text style={styles.emptyTitle}>Nothing here yet</Text>
          <Text style={styles.emptyBody}>
            Capture a thought in the note bar — it lands here instantly, gets a title from a small
            model, and becomes searchable for you and this project&apos;s agents.
          </Text>
        </View>
      ) : visible.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No results</Text>
          <Text style={styles.emptyBody}>Nothing matches this search — try fewer words.</Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => item.payload.noteKey}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm, paddingBottom: 140 }}
          renderItem={({ item }) => (
            <NoteRow
              baseUrl={baseUrl!}
              item={item}
              onViewImage={(uri) =>
                setViewer({ uri, title: item.displayTitle, markdown: item.payload.text })
              }
              projectId={projectId}
            />
          )}
        />
      )}
      <Modal
        animationType="fade"
        onRequestClose={() => setViewer(null)}
        statusBarTranslucent
        transparent
        visible={viewer !== null}
      >
        {viewer ? (
          <MediaViewer
            markdown={viewer.markdown}
            onClose={() => setViewer(null)}
            tags={[]}
            title={viewer.title}
            uri={viewer.uri}
          />
        ) : null}
      </Modal>
    </View>
  );
}

function NoteRow({
  baseUrl,
  item,
  onViewImage,
  projectId,
}: {
  baseUrl: string;
  item: NoteListItem;
  onViewImage: (uri: string) => void;
  projectId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // Inline two-step confirm (the media wipe-link shape), not Alert.alert —
  // react-native-web leaves Alert unimplemented, and the Playwright spec
  // lane drives the web build.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // null = not editing; the string is the draft.
  const [editDraft, setEditDraft] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: async (text: string) => {
      const project = await getProjectItx(baseUrl, projectId);
      // The updated event arrives over the live stream and re-renders the
      // row (text overlaid, derived title reset until fresh analysis lands).
      await project.streams
        .get(NOTES_STREAM_PATH)
        .append(buildUpdatedEvent(item.payload.noteKey, text, Date.now().toString(36)));
    },
    onSuccess: () => setEditDraft(null),
  });
  const remove = useMutation({
    mutationFn: async () => {
      const project = await getProjectItx(baseUrl, projectId);
      // The tombstone arrives over the live stream; deriveNotesList drops the
      // row — nothing to invalidate.
      await project.streams.get(NOTES_STREAM_PATH).append(buildDeletedEvent(item.payload.noteKey));
    },
  });
  const reanalyze = useMutation({
    mutationFn: async () => {
      const project = await getProjectItx(baseUrl, projectId);
      await project.streams
        .get(NOTES_STREAM_PATH)
        .append(buildReanalyzeEvent(item.payload.noteKey, Date.now().toString(36)));
    },
  });
  return (
    <Pressable
      onLongPress={() => {
        setExpanded(true);
        setConfirmingDelete(true);
      }}
      onPress={() => setExpanded(!expanded)}
      style={styles.row}
    >
      <View style={styles.rowBody}>
        <Text numberOfLines={expanded ? undefined : 1} style={styles.rowTitle}>
          {item.displayTitle || "(empty note)"}
        </Text>
        {editDraft !== null ? (
          <TextInput
            value={editDraft}
            onChangeText={setEditDraft}
            multiline
            accessibilityLabel="Edit note text"
            style={styles.editInput}
          />
        ) : item.payload.text !== "" &&
          (expanded || item.payload.text.trim() !== item.displayTitle) ? (
          <Text
            numberOfLines={expanded ? undefined : 2}
            selectable={expanded}
            style={styles.rowText}
          >
            {item.payload.text}
          </Text>
        ) : null}
        {item.payload.attachments.length > 0 ? (
          <View style={styles.thumbRow}>
            {item.payload.attachments.map((attachment) => (
              <NoteThumb
                attachment={attachment}
                baseUrl={baseUrl}
                key={attachment.path}
                onViewImage={onViewImage}
                projectId={projectId}
              />
            ))}
          </View>
        ) : null}
        <View style={styles.rowTags}>
          {item.tags.map((tag) => (
            <Text key={tag} style={styles.rowTag}>
              {tag}
            </Text>
          ))}
          <Text style={styles.rowDate}>
            {new Date(item.payload.capturedOnDeviceAt || item.capturedEventAt).toLocaleString()}
          </Text>
        </View>
        {item.analysisError !== "" ? (
          <Text style={styles.rowError}>analysis failed: {item.analysisError}</Text>
        ) : null}
        {expanded && editDraft !== null ? (
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={update.isPending || editDraft.trim() === ""}
              onPress={() => update.mutate(editDraft.trim())}
              style={[styles.actionButton, { borderColor: colors.accent }]}
            >
              <Text style={[styles.actionText, { color: colors.accent }]}>
                {update.isPending ? "Saving…" : "Save"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setEditDraft(null)}
              style={styles.actionButton}
            >
              <Text style={styles.actionText}>Cancel</Text>
            </Pressable>
          </View>
        ) : expanded ? (
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setEditDraft(item.payload.text)}
              style={styles.actionButton}
            >
              <Text style={styles.actionText}>✏️ Edit</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={reanalyze.isPending}
              onPress={() => reanalyze.mutate()}
              style={styles.actionButton}
            >
              <Text style={styles.actionText}>
                {reanalyze.isPending ? "Re-analyzing…" : "Re-analyze"}
              </Text>
            </Pressable>
            {confirmingDelete ? (
              <Pressable
                accessibilityRole="button"
                disabled={remove.isPending}
                onPress={() => remove.mutate()}
                style={[styles.actionButton, { borderColor: colors.danger }]}
              >
                <Text style={[styles.actionText, { color: colors.danger }]}>
                  {remove.isPending ? "Deleting…" : "Yes, delete this note"}
                </Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={() => setConfirmingDelete(true)}
                style={styles.actionButton}
              >
                <Text style={[styles.actionText, { color: colors.danger }]}>Delete…</Text>
              </Pressable>
            )}
          </View>
        ) : null}
        {remove.isError ? (
          <Text style={styles.rowError}>{String(remove.error.message)}</Text>
        ) : null}
        {update.isError ? (
          <Text style={styles.rowError}>{String(update.error.message)}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function NoteThumb({
  attachment,
  baseUrl,
  onViewImage,
  projectId,
}: {
  attachment: NoteAttachment;
  baseUrl: string;
  onViewImage: (uri: string) => void;
  projectId: string;
}) {
  // Same signed-URL source the media gallery and agents use.
  const imageUrl = useQuery({
    queryKey: ["note-attachment-url", projectId, attachment.path],
    queryFn: async () => {
      const project = await getProjectItx(baseUrl, projectId);
      return await project.files.get(attachment.path).url();
    },
    staleTime: Infinity,
  });
  return (
    <Pressable
      accessibilityLabel={`View ${attachment.filename}`}
      disabled={imageUrl.data === undefined}
      onPress={() => imageUrl.data && onViewImage(imageUrl.data)}
    >
      {imageUrl.data ? (
        <Image source={{ uri: imageUrl.data }} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder]} />
      )}
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
  center: { alignItems: "center", flex: 1, justifyContent: "center", padding: spacing.xl },
  error: { color: colors.danger, fontSize: 13, textAlign: "center" },
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
    padding: spacing.md,
  },
  rowBody: { gap: spacing.xs },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  rowText: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  editInput: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    color: colors.text,
    fontSize: 13,
    lineHeight: 18,
    minHeight: 60,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  thumbRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  thumb: { borderRadius: radius.sm, height: 72, width: 72 },
  thumbPlaceholder: { backgroundColor: colors.border },
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
  rowError: { color: colors.danger, fontSize: 12 },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  actionButton: {
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  actionText: { color: colors.textMuted, fontSize: 12, fontWeight: "500" },
});
