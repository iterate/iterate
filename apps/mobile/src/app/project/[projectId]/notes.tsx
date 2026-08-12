// Browse captured notes, convergence edition: notes are markdown files with
// frontmatter in the notes repo, so the LIST IS FILE-DERIVED — glob +
// readFiles through the notes workspace, parsed client-side. The workspace
// stream's notes/* facts are the live signal: the file query keys on the
// newest fact offset, so every capture/settlement/delete refetches. Rows
// show the analysis-written frontmatter title (first line until it lands);
// tap to expand for edit (recomposed writeFile + updated fact), re-analyze,
// "Open in docs" (the same file in the web editor), and inline-confirm
// delete (deleteFile + deleted fact; the server's commit lane emits the git
// deletion). Capture happens in the global composer, not here.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
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
  composeNoteFile,
  deriveNotesList,
  filterNotes,
  isNoteFilePath,
  latestNoteFactOffset,
  NOTE_EVENT_TYPES,
  NOTES_REPO_PATH,
  NOTES_WORKSPACE_PATH,
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

  // The live signal: notes/* facts on the workspace's stream. The list query
  // below keys on the newest fact offset, so a pushed fact = a refetch.
  const events = useLiveEvents({
    queryKey: ["note-events", baseUrl || "pending", projectId],
    read: async () => {
      const project = await getProjectItx(baseUrl!, projectId);
      return await project.streams
        .get(NOTES_WORKSPACE_PATH)
        .getEvents({ eventTypes: NOTE_EVENT_TYPES });
    },
    enabled: baseUrl !== undefined,
    eventTypes: NOTE_EVENT_TYPES,
    projectId,
    streamPath: NOTES_WORKSPACE_PATH,
  });
  const factOffset = latestNoteFactOffset(events.data || []);

  // The data: the note files themselves (files are truth — an agent's edit
  // shows up here even though it appends no fact, on the next refetch).
  const files = useQuery({
    queryKey: ["note-files", baseUrl || "pending", projectId, factOffset],
    enabled: baseUrl !== undefined,
    placeholderData: (previous: any) => previous,
    queryFn: async (): Promise<Record<string, string | null>> => {
      const project = await getProjectItx(baseUrl!, projectId);
      const workspace = project.workspaces.get(NOTES_WORKSPACE_PATH);
      try {
        const paths = (await workspace.glob(`${NOTES_REPO_PATH}/*.md`)).filter(isNoteFilePath);
        if (paths.length === 0) return {};
        return await workspace.readFiles(paths);
      } catch {
        // The workspace doesn't exist until the first capture provisions it.
        return {};
      }
    },
  });

  const items = deriveNotesList(files.data || {});
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
        {files.isFetching && !files.isPending ? (
          <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} size="small" />
        ) : null}
      </View>
      {files.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} />
        </View>
      ) : files.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>{String(files.error.message)}</Text>
          <Pressable onPress={() => void files.refetch()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Nothing here yet</Text>
          <Text style={styles.emptyBody}>
            Capture a thought in the note bar — it becomes a markdown file in this project&apos;s
            notes repo, gets a title from a small model, and is editable by you and this
            project&apos;s agents alike.
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
          keyExtractor={(item) => item.path}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm, paddingBottom: 140 }}
          renderItem={({ item }) => (
            <NoteRow
              baseUrl={baseUrl!}
              item={item}
              onViewImage={(uri) =>
                setViewer({ uri, title: item.displayTitle, markdown: item.text })
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
      // Recompose: body replaced, title/tags dropped (the fresh analysis the
      // updated fact opens will re-earn them), foreign frontmatter preserved.
      const { title: _title, tags: _tags, ...rest } = item.frontmatter;
      await project.workspaces
        .get(NOTES_WORKSPACE_PATH)
        .writeFile(item.path, composeNoteFile(rest, text));
      await project.streams
        .get(NOTES_WORKSPACE_PATH)
        .append(buildUpdatedEvent(item.path, Date.now().toString(36)));
    },
    onSuccess: () => setEditDraft(null),
  });
  const cache = useQueryClient();
  const remove = useMutation({
    mutationFn: async () => {
      const project = await getProjectItx(baseUrl, projectId);
      await project.workspaces.get(NOTES_WORKSPACE_PATH).deleteFile(item.path);
      // The server's commit lane lands the git deletion.
      await project.streams.get(NOTES_WORKSPACE_PATH).append(buildDeletedEvent(item.path));
    },
    onSuccess: () => {
      // The row vanishes NOW — the fact-driven refetch merely confirms.
      cache.setQueriesData(
        { queryKey: ["note-files"] },
        (files: Record<string, string | null> | undefined) =>
          files === undefined ? files : { ...files, [item.path]: null },
      );
    },
  });
  const reanalyze = useMutation({
    mutationFn: async () => {
      const project = await getProjectItx(baseUrl, projectId);
      await project.streams
        .get(NOTES_WORKSPACE_PATH)
        .append(buildReanalyzeEvent(item.path, Date.now().toString(36)));
    },
  });
  const openInDocs = useMutation({
    mutationFn: async () => {
      const project = await getProjectItx(baseUrl, projectId);
      const docsUrl = new URL(await project.appUrl("docs"));
      docsUrl.searchParams.set("workspace", NOTES_WORKSPACE_PATH);
      docsUrl.searchParams.set("path", item.path);
      await WebBrowser.openBrowserAsync(docsUrl.toString());
    },
  });

  return (
    <Pressable
      onLongPress={() => {
        setExpanded(true);
        setConfirmingDelete(true);
      }}
      onPress={() => {
        // While editing, a row tap must not collapse the row — that would
        // strand the editor with its Save/Cancel hidden.
        if (editDraft === null) setExpanded(!expanded);
      }}
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
        ) : item.text !== "" && (expanded || item.text.trim() !== item.displayTitle) ? (
          <Text
            numberOfLines={expanded ? undefined : 2}
            selectable={expanded}
            style={styles.rowText}
          >
            {item.text}
          </Text>
        ) : null}
        {item.attachments.length > 0 ? (
          <View style={styles.thumbRow}>
            {item.attachments.map((attachment) => (
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
            {item.capturedAt ? new Date(item.capturedAt).toLocaleString() : ""}
          </Text>
        </View>
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
              onPress={() => setEditDraft(item.text)}
              style={styles.actionButton}
            >
              <Text style={styles.actionText}>✏️ Edit</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={openInDocs.isPending}
              onPress={() => openInDocs.mutate()}
              style={styles.actionButton}
            >
              <Text style={styles.actionText}>Open in docs</Text>
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
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.xs },
  actionButton: {
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  actionText: { color: colors.textMuted, fontSize: 12, fontWeight: "500" },
});
