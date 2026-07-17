// PROTOTYPE — three mobile repo-management layouts behind ?variant=. This is
// intentionally disposable; the research verdict lives in tasks/mobile-ide-poc.md.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import CodeEditorPrototype from "../../../components/code-editor-prototype.tsx";
import { getItxSession, resetItxSession } from "../../../lib/itx.ts";
import {
  prototypeRepoStore,
  usePrototypeRepo,
  type PendingRepoChange,
  type PrototypeVariant,
} from "../../../lib/repo-ide-prototype.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

const variants: { key: PrototypeVariant; label: string }[] = [
  { key: "native", label: "Native baseline" },
  { key: "hybrid", label: "Hybrid explorer" },
  { key: "review", label: "Review first" },
];

export default function RepoIdePrototypeScreen() {
  const params = useLocalSearchParams<{ demo?: string; projectId: string; variant?: string }>();
  const projectId = params.projectId;
  const demo = params.demo === "1";
  const variant = variants.some((entry) => entry.key === params.variant)
    ? (params.variant as PrototypeVariant)
    : "hybrid";
  const queryClient = useQueryClient();
  const repoState = usePrototypeRepo(projectId);
  const store = prototypeRepoStore(projectId);

  const files = useQuery({
    queryKey: ["mobile-repo-ide-prototype", projectId, demo ? "demo" : "live", "files"],
    staleTime: demo ? Infinity : 0,
    queryFn: async () => {
      if (demo) {
        const paths = Object.keys(demoRepo).sort();
        if (store.getSnapshot().headCommitOid === null) store.setHead("demo1234567890", paths);
        if (
          store.getSnapshot().selectedPath === null &&
          store.getSnapshot().headCommitOid === "demo1234567890"
        )
          store.open("src/worker.ts", demoRepo["src/worker.ts"]!);
        const current = store.getSnapshot();
        return {
          commitOid: current.headCommitOid || "demo1234567890",
          paths: current.headPaths,
          textPaths: current.headPaths,
        };
      }
      try {
        const repo = await getProjectRepo(projectId);
        const result = await repo.listFiles();
        store.setHead(result.commitOid, result.paths.filter(isTextPath));
        return { ...result, textPaths: result.paths.filter(isTextPath) };
      } catch (error) {
        resetItxSession();
        throw error;
      }
    },
  });

  const openFile = useMutation({
    mutationFn: async (path: string) => {
      if (demo) {
        const content = demoRepo[path];
        if (content === undefined) throw new Error(`Demo file no longer exists: ${path}`);
        return { commitOid: "demo1234567890", content, path };
      }
      const repo = await getProjectRepo(projectId);
      const file = await repo.readFile({ path });
      if (file === null) throw new Error(`File no longer exists: ${path}`);
      return file;
    },
    onSuccess: (file) => store.open(file.path, file.content),
    onError: (error) => {
      if (!demo) resetItxSession();
      Alert.alert("Could not open file", error.message);
    },
  });

  const commit = useMutation({
    mutationFn: async () => {
      const current = store.getSnapshot();
      const pending = store.pendingChanges();
      const message = current.commitMessage.trim();
      if (current.headChanged) throw new Error("HEAD changed. Discard or reload this prototype.");
      if (message === "") throw new Error("Enter a commit message.");
      if (pending.length === 0) throw new Error("There are no changes to commit.");
      const result = demo
        ? {
            branch: "main",
            changedPaths: pending.map((change) => change.path),
            commitOid: `demo${Date.now()}`,
            noChanges: false,
          }
        : await (
            await getProjectRepo(projectId)
          ).commitFiles({
            message,
            changes: pending.map((change) =>
              change.kind === "delete"
                ? { path: change.path, delete: true as const }
                : { path: change.path, content: change.content },
            ),
          });
      return { pending, result };
    },
    onSuccess: async ({ pending, result }) => {
      store.acceptCommit(result.commitOid, pending);
      if (!demo)
        await queryClient.invalidateQueries({
          queryKey: ["mobile-repo-ide-prototype", projectId, "live", "files"],
        });
      if (!demo)
        Alert.alert(
          result.noChanges ? "Nothing changed" : "Committed",
          result.noChanges
            ? "The repo already contained those contents."
            : `${result.changedPaths.length} file(s) committed to ${result.branch}.`,
        );
    },
    onError: (error) => {
      if (!demo) resetItxSession();
      Alert.alert("Could not commit", error.message);
    },
  });

  const openPath = (path: string) => {
    if (repoState.buffers[path]) store.select(path);
    else openFile.mutate(path);
  };
  const filteredPaths = repoState.paths.filter((path) =>
    path.toLowerCase().includes(repoState.filter.toLowerCase()),
  );
  const workspaceProps: WorkspaceProps = {
    buffers: repoState.buffers,
    filter: repoState.filter,
    isOpening: openFile.isPending,
    onChange: (content) => store.updateSelected(content),
    onDelete: (path) =>
      Alert.alert("Delete file?", path, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => store.remove(path) },
      ]),
    onDiscard: (path) => store.discard(path),
    onFilter: (filter) => store.setFilter(filter),
    onOpen: openPath,
    paths: filteredPaths,
    pending: repoState.pending,
    selectedBuffer: repoState.selectedBuffer,
    selectedPath: repoState.selectedPath,
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "IDE prototype" }} />
      <View style={styles.prototypeBanner}>
        <Text style={styles.prototypeLabel}>
          EXPERIMENTAL · {demo ? "DEMO DATA" : "CONFIG REPO"}
        </Text>
        <Text style={styles.headLabel}>
          {files.data ? files.data.commitOid.slice(0, 8) : "loading…"}
          {files.data && files.data.paths.length !== files.data.textPaths.length
            ? ` · ${files.data.paths.length - files.data.textPaths.length} binary hidden`
            : ""}
        </Text>
      </View>
      <CreateFileBar
        newPath={repoState.newPath}
        onChange={(newPath) => store.setNewPath(newPath)}
        onCreate={() => {
          try {
            store.create();
          } catch (error) {
            Alert.alert(
              "Could not create file",
              error instanceof Error ? error.message : "Invalid path",
            );
          }
        }}
      />
      {files.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textMuted} />
          <Text style={styles.muted}>Loading config repo…</Text>
        </View>
      ) : files.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>{files.error.message}</Text>
          <Pressable style={styles.outlineButton} onPress={() => files.refetch()}>
            <Text style={styles.buttonText}>Retry</Text>
          </Pressable>
        </View>
      ) : variant === "native" ? (
        <NativeWorkbench {...workspaceProps} />
      ) : variant === "review" ? (
        <ReviewWorkbench {...workspaceProps} />
      ) : (
        <HybridWorkbench {...workspaceProps} />
      )}
      <CommitDock
        commitMessage={repoState.commitMessage}
        committing={commit.isPending}
        headChanged={repoState.headChanged}
        onChange={(message) => store.setCommitMessage(message)}
        onCommit={() => commit.mutate()}
        onReload={() =>
          Alert.alert("Discard local changes?", "Reload the repo's latest HEAD.", [
            { text: "Cancel", style: "cancel" },
            {
              text: "Discard and reload",
              style: "destructive",
              onPress: () => {
                if (files.data) store.replaceHead(files.data.commitOid, files.data.textPaths);
              },
            },
          ])
        }
        pending={repoState.pending}
      />
      {__DEV__ ? <PrototypeSwitcher current={variant} /> : null}
    </View>
  );
}

type WorkspaceProps = {
  buffers: Record<string, { current: string | null; head: string | null; loaded: boolean }>;
  filter: string;
  isOpening: boolean;
  onChange: (content: string) => void;
  onDelete: (path: string) => void;
  onDiscard: (path: string) => void;
  onFilter: (filter: string) => void;
  onOpen: (path: string) => void;
  paths: string[];
  pending: PendingRepoChange[];
  selectedBuffer: { current: string | null; head: string | null; loaded: boolean } | undefined;
  selectedPath: string | null;
};

function NativeWorkbench(props: WorkspaceProps) {
  return (
    <View style={styles.workbench}>
      <View style={styles.nativeExplorer}>
        <VariantHeading
          title="Native baseline"
          detail="FlatList + multiline TextInput: zero bridge, zero syntax highlighting"
        />
        <FileSearch value={props.filter} onChange={props.onFilter} />
        <FileList {...props} />
      </View>
      <View style={styles.nativeEditor}>
        <EditorHeader {...props} />
        {props.selectedPath && props.selectedBuffer?.current !== null ? (
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onChangeText={props.onChange}
            selectionColor={colors.accent}
            spellCheck={false}
            style={styles.nativeInput}
            value={props.selectedBuffer?.current || ""}
          />
        ) : (
          <EmptyEditor isOpening={props.isOpening} />
        )}
      </View>
    </View>
  );
}

function HybridWorkbench(props: WorkspaceProps) {
  return (
    <View style={styles.workbench}>
      <VariantHeading
        title="Hybrid explorer"
        detail="Native file chrome with a bundled CodeMirror WebView"
      />
      <FileSearch value={props.filter} onChange={props.onFilter} />
      <View style={styles.hybridFiles}>
        <FileList {...props} horizontal />
      </View>
      <View style={styles.webEditor}>
        <EditorHeader {...props} />
        <WebEditor {...props} />
      </View>
    </View>
  );
}

function ReviewWorkbench(props: WorkspaceProps) {
  return (
    <View style={styles.workbench}>
      <VariantHeading
        title="Review first"
        detail="Pending mutations stay visible while the editor occupies the middle"
      />
      <View style={styles.pendingPanel}>
        <Text style={styles.sectionLabel}>PENDING ({props.pending.length})</Text>
        <PendingList pending={props.pending} onDiscard={props.onDiscard} onOpen={props.onOpen} />
      </View>
      <View style={styles.reviewEditor}>
        <EditorHeader {...props} />
        <WebEditor {...props} />
      </View>
      <View style={styles.reviewBrowser}>
        <FileSearch value={props.filter} onChange={props.onFilter} compact />
        <FileList {...props} horizontal />
      </View>
    </View>
  );
}

function WebEditor(props: WorkspaceProps) {
  if (!props.selectedPath || props.selectedBuffer?.current === null)
    return <EmptyEditor isOpening={props.isOpening} />;
  return (
    <CodeEditorPrototype
      dom={{ scrollEnabled: false, style: { flex: 1 } }}
      onChange={async (content) => props.onChange(content)}
      path={props.selectedPath}
      value={props.selectedBuffer?.current || ""}
    />
  );
}

function FileList(props: WorkspaceProps & { horizontal?: boolean }) {
  return (
    <FlatList
      contentContainerStyle={
        props.horizontal ? styles.horizontalFilesContent : styles.fileListContent
      }
      data={props.paths}
      horizontal={props.horizontal}
      keyboardShouldPersistTaps="handled"
      keyExtractor={(path) => path}
      ListEmptyComponent={<Text style={styles.muted}>No matching text files.</Text>}
      renderItem={({ item: path }) => {
        const dirty = props.buffers[path]?.current !== props.buffers[path]?.head;
        return (
          <Pressable
            onPress={() => props.onOpen(path)}
            style={[
              props.horizontal ? styles.fileChip : styles.fileRow,
              props.selectedPath === path && styles.fileSelected,
            ]}
          >
            <Text numberOfLines={1} style={styles.fileName}>
              {dirty ? "● " : ""}
              {path.split("/").pop()}
            </Text>
            {!props.horizontal ? (
              <Text numberOfLines={1} style={styles.fileParent}>
                {path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/"}
              </Text>
            ) : null}
          </Pressable>
        );
      }}
      showsHorizontalScrollIndicator={false}
    />
  );
}

function PendingList({
  onDiscard,
  onOpen,
  pending,
}: {
  onDiscard: (path: string) => void;
  onOpen: (path: string) => void;
  pending: PendingRepoChange[];
}) {
  if (pending.length === 0) return <Text style={styles.muted}>Working tree clean.</Text>;
  return (
    <ScrollView horizontal contentContainerStyle={styles.pendingContent}>
      {pending.map((change) => (
        <View key={change.path} style={styles.changeChip}>
          <Pressable disabled={change.kind === "delete"} onPress={() => onOpen(change.path)}>
            <Text style={styles.changeKind}>{change.kind.toUpperCase()}</Text>
            <Text numberOfLines={1} style={styles.changePath}>
              {change.path}
            </Text>
          </Pressable>
          <Pressable onPress={() => onDiscard(change.path)}>
            <Text style={styles.discardText}>Discard</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

function EditorHeader(props: WorkspaceProps) {
  const dirty =
    props.selectedPath !== null && props.selectedBuffer?.current !== props.selectedBuffer?.head;
  return (
    <View style={styles.editorHeader}>
      <Text numberOfLines={1} style={styles.editorPath}>
        {props.selectedPath ? `${dirty ? "● " : ""}${props.selectedPath}` : "No file open"}
      </Text>
      {props.selectedPath ? (
        <View style={styles.editorActions}>
          {dirty ? (
            <Pressable onPress={() => props.onDiscard(props.selectedPath!)}>
              <Text style={styles.headerAction}>Discard</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => props.onDelete(props.selectedPath!)}>
            <Text style={styles.deleteAction}>Delete</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function EmptyEditor({ isOpening }: { isOpening: boolean }) {
  return (
    <View style={styles.center}>
      {isOpening ? <ActivityIndicator color={colors.textMuted} /> : null}
      <Text style={styles.muted}>{isOpening ? "Opening file…" : "Choose a file to edit."}</Text>
    </View>
  );
}

function FileSearch({
  compact = false,
  onChange,
  value,
}: {
  compact?: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <TextInput
      autoCapitalize="none"
      autoCorrect={false}
      onChangeText={onChange}
      placeholder="Filter paths…"
      placeholderTextColor={colors.textFaint}
      style={[styles.search, compact && styles.searchCompact]}
      value={value}
    />
  );
}

function CreateFileBar({
  newPath,
  onChange,
  onCreate,
}: {
  newPath: string;
  onChange: (value: string) => void;
  onCreate: () => void;
}) {
  return (
    <View style={styles.createBar}>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={onChange}
        onSubmitEditing={onCreate}
        placeholder="new/path.ts"
        placeholderTextColor={colors.textFaint}
        style={styles.createInput}
        value={newPath}
      />
      <Pressable style={styles.smallButton} onPress={onCreate}>
        <Text style={styles.smallButtonText}>New file</Text>
      </Pressable>
    </View>
  );
}

function CommitDock({
  commitMessage,
  committing,
  headChanged,
  onChange,
  onCommit,
  onReload,
  pending,
}: {
  commitMessage: string;
  committing: boolean;
  headChanged: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
  onReload: () => void;
  pending: PendingRepoChange[];
}) {
  const disabled = committing || (!headChanged && pending.length === 0);
  return (
    <View style={styles.commitDock}>
      <TextInput
        onChangeText={onChange}
        placeholder="Commit message"
        placeholderTextColor={colors.textFaint}
        style={styles.commitInput}
        value={commitMessage}
      />
      <Pressable
        disabled={disabled}
        onPress={headChanged ? onReload : onCommit}
        style={[styles.commitButton, disabled && styles.buttonDisabled]}
      >
        <Text style={styles.commitButtonText}>
          {headChanged ? "Reload HEAD" : committing ? "Committing…" : `Commit ${pending.length}`}
        </Text>
      </Pressable>
    </View>
  );
}

function VariantHeading({ detail, title }: { detail: string; title: string }) {
  return (
    <View style={styles.variantHeading}>
      <Text style={styles.variantTitle}>{title}</Text>
      <Text numberOfLines={1} style={styles.variantDetail}>
        {detail}
      </Text>
    </View>
  );
}

function PrototypeSwitcher({ current }: { current: PrototypeVariant }) {
  const index = variants.findIndex((variant) => variant.key === current);
  const go = (offset: number) => {
    const next = variants[(index + offset + variants.length) % variants.length];
    if (next) router.setParams({ variant: next.key });
  };
  return (
    <View style={styles.switcher}>
      <Pressable hitSlop={12} onPress={() => go(-1)}>
        <Text style={styles.switchArrow}>‹</Text>
      </Pressable>
      <Text style={styles.switchLabel}>
        {index + 1}/{variants.length} · {variants[index]?.label}
      </Text>
      <Pressable hitSlop={12} onPress={() => go(1)}>
        <Text style={styles.switchArrow}>›</Text>
      </Pressable>
    </View>
  );
}

async function getProjectRepo(projectId: string) {
  const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
  const itx = await getItxSession(baseUrl);
  const project = await itx.projects.get(projectId);
  return project.repo;
}

function isTextPath(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  return ![
    "avif",
    "bmp",
    "eot",
    "gif",
    "ico",
    "jpeg",
    "jpg",
    "mp3",
    "mp4",
    "pdf",
    "png",
    "ttf",
    "webm",
    "webp",
    "woff",
    "woff2",
    "zip",
  ].includes(extension || "");
}

const demoRepo: Record<string, string> = {
  "README.md": "# Weather desk\n\nA tiny Iterate project used to judge the mobile IDE.\n",
  "package.json":
    '{\n  "name": "weather-desk",\n  "dependencies": {\n    "hono": "latest"\n  }\n}\n',
  "src/forecast.ts": `export async function forecast(city: string) {
  const response = await fetch(\`https://weather.example/\${city}\`);
  return response.json();
}
`,
  "src/worker.ts": `import { Hono } from "hono";
import { forecast } from "./forecast.ts";

const app = new Hono();

app.get("/weather/:city", async (context) => {
  const result = await forecast(context.req.param("city"));
  return context.json(result);
});

export default app;
`,
  "tasks/improve-forecast.md":
    "# Improve forecast\n\n- [ ] Add a five-day view\n- [ ] Cache upstream responses\n",
  "wrangler.jsonc": '{\n  "name": "weather-desk",\n  "main": "src/worker.ts"\n}\n',
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm },
  muted: { color: colors.textMuted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13, textAlign: "center", padding: spacing.md },
  prototypeBanner: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: "#202015",
  },
  prototypeLabel: { color: colors.working, fontSize: 10, fontWeight: "800", letterSpacing: 0.8 },
  headLabel: { color: colors.textMuted, fontSize: 10, fontFamily: "Menlo" },
  createBar: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.sm,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  createInput: {
    flex: 1,
    color: colors.text,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontFamily: "Menlo",
    fontSize: 12,
  },
  smallButton: {
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
  },
  smallButtonText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  workbench: { flex: 1, minHeight: 0 },
  variantHeading: { paddingHorizontal: spacing.sm, paddingTop: 6, paddingBottom: 4 },
  variantTitle: { color: colors.text, fontSize: 12, fontWeight: "800" },
  variantDetail: { color: colors.textFaint, fontSize: 10 },
  nativeExplorer: { flex: 4, minHeight: 0, borderBottomWidth: 1, borderColor: colors.border },
  nativeEditor: { flex: 6, minHeight: 0 },
  search: {
    color: colors.text,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    marginHorizontal: spacing.sm,
    marginBottom: spacing.xs,
    paddingHorizontal: 12,
    paddingVertical: 7,
    fontSize: 12,
  },
  searchCompact: { minWidth: 140, marginBottom: 0 },
  fileListContent: { paddingHorizontal: spacing.sm, paddingBottom: spacing.sm, gap: 4 },
  horizontalFilesContent: { paddingHorizontal: spacing.sm, gap: 6, alignItems: "center" },
  fileRow: {
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.surface,
  },
  fileChip: {
    maxWidth: 180,
    borderRadius: radius.full,
    paddingHorizontal: 11,
    paddingVertical: 7,
    backgroundColor: colors.surface,
  },
  fileSelected: { backgroundColor: "#233b35", borderColor: colors.accent, borderWidth: 1 },
  fileName: { color: colors.text, fontSize: 12, fontFamily: "Menlo" },
  fileParent: { color: colors.textFaint, fontSize: 10, fontFamily: "Menlo" },
  editorHeader: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  editorPath: { flex: 1, color: colors.text, fontFamily: "Menlo", fontSize: 11 },
  editorActions: { flexDirection: "row", gap: spacing.sm },
  headerAction: { color: colors.textMuted, fontSize: 11 },
  deleteAction: { color: colors.danger, fontSize: 11 },
  nativeInput: {
    flex: 1,
    color: colors.text,
    padding: 12,
    paddingBottom: 100,
    fontFamily: "Menlo",
    fontSize: 14,
    lineHeight: 21,
    textAlignVertical: "top",
  },
  hybridFiles: { height: 42 },
  webEditor: { flex: 1, minHeight: 0, borderTopWidth: 1, borderColor: colors.border },
  pendingPanel: { height: 94, paddingHorizontal: spacing.sm },
  sectionLabel: {
    color: colors.textFaint,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.7,
    marginBottom: 4,
  },
  pendingContent: { gap: 6 },
  changeChip: {
    width: 150,
    justifyContent: "space-between",
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: 7,
  },
  changeKind: { color: colors.accent, fontSize: 9, fontWeight: "800" },
  changePath: { color: colors.text, fontFamily: "Menlo", fontSize: 10 },
  discardText: { color: colors.textMuted, fontSize: 9 },
  reviewEditor: {
    flex: 1,
    minHeight: 0,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  reviewBrowser: { height: 48, flexDirection: "row", alignItems: "center" },
  commitDock: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.sm,
    paddingBottom: 54,
    borderTopWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  commitInput: {
    flex: 1,
    color: colors.text,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
  },
  commitButton: {
    minWidth: 94,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
  },
  commitButtonText: { color: "#07120f", fontSize: 12, fontWeight: "800" },
  buttonDisabled: { opacity: 0.35 },
  switcher: {
    position: "absolute",
    bottom: 8,
    alignSelf: "center",
    height: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    backgroundColor: "#ececf1",
    borderRadius: radius.full,
    paddingHorizontal: 14,
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  switchArrow: { color: "#0b0b0f", fontSize: 27, lineHeight: 29 },
  switchLabel: { color: "#0b0b0f", fontSize: 11, fontWeight: "800" },
  outlineButton: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  buttonText: { color: colors.text, fontSize: 12 },
});
