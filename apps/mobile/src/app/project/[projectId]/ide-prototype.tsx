// PROTOTYPE — a native repo drawer around a bundled CodeMirror DOM component.
// This is intentionally disposable; the research verdict lives in tasks/mobile-ide-poc.md.

import Feather from "@expo/vector-icons/Feather";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { Component, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { TreeView, type NodeRowProps, type TreeNode } from "react-native-tree-multi-select";
import CodeEditorPrototype from "../../../components/code-editor-prototype.tsx";
import { getItxSession, resetItxSession } from "../../../lib/itx.ts";
import {
  prototypeRepoStore,
  usePrototypeRepo,
  type PendingRepoChange,
} from "../../../lib/repo-ide-prototype.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

export default function RepoIdePrototypeScreen() {
  const params = useLocalSearchParams<{ demo?: string; projectId: string }>();
  const projectId = params.projectId;
  const demo = params.demo === "1";
  const queryClient = useQueryClient();
  const repoState = usePrototypeRepo(projectId);
  const store = prototypeRepoStore(projectId);
  const { width } = useWindowDimensions();
  const drawerWidth = Math.min(width - 28, 420);

  const files = useQuery({
    queryKey: ["mobile-repo-ide-prototype", projectId, demo ? "demo" : "live", "files"],
    staleTime: demo ? Infinity : 0,
    queryFn: async () => {
      if (demo) {
        const paths = Object.keys(demoRepo).sort();
        if (store.getSnapshot().headCommitOid === null) store.setHead("demo1234567890", paths);
        if (store.getSnapshot().selectedPath === null)
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
      const file = await (await getProjectRepo(projectId)).readFile({ path });
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
      if (current.headChanged) throw new Error("HEAD changed. Reload before committing.");
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
    store.closeDrawer();
    if (repoState.buffers[path]) store.select(path);
    else openFile.mutate(path);
  };
  const filteredPaths = repoState.paths.filter((path) =>
    path.toLowerCase().includes(repoState.filter.toLowerCase()),
  );
  const tree = repoTree(filteredPaths, repoState.buffers, repoState.selectedPath, openPath);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Repo" }} />
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
      <View style={styles.workbench}>
        {files.isPending ? (
          <EmptyEditor label="Loading config repo…" />
        ) : files.isError ? (
          <View style={styles.center}>
            <Text style={styles.error}>{files.error.message}</Text>
            <Pressable style={styles.outlineButton} onPress={() => files.refetch()}>
              <Text style={styles.buttonText}>Retry</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <EditorHeader
              dirty={
                repoState.selectedPath !== null &&
                repoState.selectedBuffer?.current !== repoState.selectedBuffer?.head
              }
              onDelete={() => {
                const path = repoState.selectedPath;
                if (!path) return;
                Alert.alert("Delete file?", path, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Delete", style: "destructive", onPress: () => store.remove(path) },
                ]);
              }}
              onDiscard={() => {
                if (repoState.selectedPath) store.discard(repoState.selectedPath);
              }}
              onOpenDrawer={() => store.openDrawer("files")}
              path={repoState.selectedPath}
            />
            {repoState.selectedPath && repoState.selectedBuffer?.current !== null ? (
              <CodeEditorPrototype
                dom={{ scrollEnabled: false, style: { flex: 1 } }}
                onChange={async (content) => store.updateSelected(content)}
                path={repoState.selectedPath}
                value={repoState.selectedBuffer?.current || ""}
              />
            ) : (
              <EmptyEditor
                label={openFile.isPending ? "Opening file…" : "Choose a file to edit."}
              />
            )}
          </>
        )}

        <SlidingDrawer open={repoState.drawerOpen} width={drawerWidth}>
          <View style={styles.drawerRail}>
            <DrawerIcon
              active={repoState.drawerView === "files"}
              icon="folder"
              label="Files"
              onPress={() => store.openDrawer("files")}
            />
            <DrawerIcon
              active={repoState.drawerView === "git"}
              badge={repoState.pending.length}
              icon="git-branch"
              label="Source control"
              onPress={() => store.openDrawer("git")}
            />
          </View>
          <View style={styles.drawerContent}>
            <View style={styles.drawerHeader}>
              <View>
                <Text style={styles.drawerEyebrow}>
                  {repoState.drawerView === "files" ? "EXPLORER" : "SOURCE CONTROL"}
                </Text>
                <Text style={styles.drawerTitle}>
                  {repoState.drawerView === "files" ? "Project files" : "Working tree"}
                </Text>
              </View>
              <Pressable
                accessibilityLabel="Hide drawer"
                hitSlop={12}
                onPress={() => store.closeDrawer()}
              >
                <Text style={styles.drawerToggle}>{"<<"}</Text>
              </Pressable>
            </View>
            {repoState.drawerView === "files" ? (
              <FileDrawer
                filter={repoState.filter}
                newPath={repoState.newPath}
                onCreate={() => {
                  try {
                    store.create();
                    store.closeDrawer();
                  } catch (error) {
                    Alert.alert(
                      "Could not create file",
                      error instanceof Error ? error.message : "Invalid path",
                    );
                  }
                }}
                onFilter={(filter) => store.setFilter(filter)}
                onNewPath={(newPath) => store.setNewPath(newPath)}
                tree={tree}
              />
            ) : (
              <GitDrawer
                commitMessage={repoState.commitMessage}
                committing={commit.isPending}
                headChanged={repoState.headChanged}
                onChange={(message) => store.setCommitMessage(message)}
                onCommit={() => commit.mutate()}
                onDiscard={(path) => store.discard(path)}
                onOpen={openPath}
                onReload={() =>
                  Alert.alert("Discard local changes?", "Reload the repo's latest HEAD.", [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Discard and reload",
                      style: "destructive",
                      onPress: () => {
                        if (files.data)
                          store.replaceHead(files.data.commitOid, files.data.textPaths);
                      },
                    },
                  ])
                }
                pending={repoState.pending}
              />
            )}
          </View>
        </SlidingDrawer>
      </View>
    </View>
  );
}

function FileDrawer({
  filter,
  newPath,
  onCreate,
  onFilter,
  onNewPath,
  tree,
}: {
  filter: string;
  newPath: string;
  onCreate: () => void;
  onFilter: (value: string) => void;
  onNewPath: (value: string) => void;
  tree: RepoTreeNode[];
}) {
  return (
    <View style={styles.drawerPanel}>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={onFilter}
        placeholder="Filter paths…"
        placeholderTextColor={colors.textFaint}
        style={styles.search}
        value={filter}
      />
      <View style={styles.treeFrame}>
        {tree.length === 0 ? (
          <Text style={styles.muted}>No matching text files.</Text>
        ) : (
          <TreeView
            CustomNodeRowComponent={RepoTreeRow}
            data={tree}
            indentationMultiplier={16}
            preExpandedIds={directoryIds(tree)}
            selectionPropagation={{ toChildren: false, toParents: false }}
            treeFlashListProps={{ keyboardShouldPersistTaps: "handled" }}
          />
        )}
      </View>
      <View style={styles.createBar}>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={onNewPath}
          onSubmitEditing={onCreate}
          placeholder="new/path.ts"
          placeholderTextColor={colors.textFaint}
          style={styles.createInput}
          value={newPath}
        />
        <Pressable style={styles.smallButton} onPress={onCreate}>
          <Feather color={colors.text} name="file-plus" size={16} />
        </Pressable>
      </View>
    </View>
  );
}

function GitDrawer({
  commitMessage,
  committing,
  headChanged,
  onChange,
  onCommit,
  onDiscard,
  onOpen,
  onReload,
  pending,
}: {
  commitMessage: string;
  committing: boolean;
  headChanged: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
  onDiscard: (path: string) => void;
  onOpen: (path: string) => void;
  onReload: () => void;
  pending: PendingRepoChange[];
}) {
  const disabled = committing || (!headChanged && pending.length === 0);
  return (
    <View style={styles.drawerPanel}>
      <View style={styles.commitForm}>
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
          <Feather color="#07120f" name="git-commit" size={15} />
          <Text style={styles.commitButtonText}>
            {headChanged ? "Reload HEAD" : committing ? "Committing…" : `Commit ${pending.length}`}
          </Text>
        </Pressable>
      </View>
      <View style={styles.changeHeading}>
        <Text style={styles.drawerEyebrow}>CHANGES</Text>
        <Text style={styles.changeCount}>{pending.length}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.changeList}>
        {pending.length === 0 ? <Text style={styles.muted}>Working tree clean.</Text> : null}
        {pending.map((change) => (
          <View key={change.path} style={styles.changeRow}>
            <Pressable
              disabled={change.kind === "delete"}
              onPress={() => onOpen(change.path)}
              style={styles.changePathButton}
            >
              <Text numberOfLines={1} style={styles.changePath}>
                {change.path}
              </Text>
            </Pressable>
            <Text style={styles.changeKind}>
              {change.kind === "create" ? "A" : change.kind === "delete" ? "D" : "M"}
            </Text>
            <Pressable
              accessibilityLabel={`Discard ${change.path}`}
              onPress={() => onDiscard(change.path)}
            >
              <Feather color={colors.textMuted} name="rotate-ccw" size={14} />
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

type RepoTreeNode = TreeNode<string> & {
  dirty: boolean;
  kind: "directory" | "file";
  onOpen?: () => void;
  path: string;
  selected: boolean;
};

function RepoTreeRow({ isExpanded, level, node, onExpand }: NodeRowProps<string>) {
  const repoNode = node as RepoTreeNode;
  const directory = repoNode.kind === "directory";
  return (
    <Pressable
      accessibilityRole="button"
      onPress={directory ? onExpand : repoNode.onOpen}
      style={[
        styles.treeRow,
        { paddingLeft: 8 + level * 16 },
        repoNode.selected && styles.treeRowSelected,
      ]}
    >
      <Feather
        color={directory ? colors.working : colors.textMuted}
        name={directory ? (isExpanded ? "folder-minus" : "folder-plus") : "file-text"}
        size={15}
      />
      <Text numberOfLines={1} style={styles.treeName}>
        {repoNode.name}
      </Text>
      {repoNode.dirty ? <Text style={styles.dirtyDot}>●</Text> : null}
    </Pressable>
  );
}

function DrawerIcon({
  active,
  badge = 0,
  icon,
  label,
  onPress,
}: {
  active: boolean;
  badge?: number;
  icon: "folder" | "git-branch";
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.railButton, active && styles.railButtonActive]}
    >
      <Feather color={active ? colors.text : colors.textMuted} name={icon} size={20} />
      {badge > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

class SlidingDrawer extends Component<{
  children: ReactNode;
  open: boolean;
  width: number;
}> {
  translateX = new Animated.Value(this.props.open ? 0 : -this.props.width);

  componentDidUpdate(previous: Readonly<{ open: boolean; width: number }>) {
    if (previous.open === this.props.open && previous.width === this.props.width) return;
    Animated.spring(this.translateX, {
      bounciness: 0,
      speed: 24,
      toValue: this.props.open ? 0 : -this.props.width,
      useNativeDriver: true,
    }).start();
  }

  render() {
    return (
      <Animated.View
        pointerEvents={this.props.open ? "auto" : "none"}
        style={[
          styles.drawer,
          { transform: [{ translateX: this.translateX }], width: this.props.width },
        ]}
      >
        {this.props.children}
      </Animated.View>
    );
  }
}

function EditorHeader({
  dirty,
  onDelete,
  onDiscard,
  onOpenDrawer,
  path,
}: {
  dirty: boolean;
  onDelete: () => void;
  onDiscard: () => void;
  onOpenDrawer: () => void;
  path: string | null;
}) {
  return (
    <View style={styles.editorHeader}>
      <Pressable accessibilityLabel="Show file drawer" hitSlop={8} onPress={onOpenDrawer}>
        <Text style={styles.drawerToggle}>{">>"}</Text>
      </Pressable>
      <Text numberOfLines={1} style={styles.editorPath}>
        {path ? `${dirty ? "● " : ""}${path}` : "No file open"}
      </Text>
      {path ? (
        <View style={styles.editorActions}>
          {dirty ? (
            <Pressable onPress={onDiscard}>
              <Text style={styles.headerAction}>Discard</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={onDelete}>
            <Text style={styles.deleteAction}>Delete</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function EmptyEditor({ label }: { label: string }) {
  return (
    <View style={styles.center}>
      {label.endsWith("…") ? <ActivityIndicator color={colors.textMuted} /> : null}
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

function repoTree(
  paths: string[],
  buffers: Record<string, { current: string | null; head: string | null }>,
  selectedPath: string | null,
  onOpen: (path: string) => void,
) {
  const roots: RepoTreeNode[] = [];
  for (const path of paths) {
    const segments = path.split("/");
    let children = roots;
    let parentPath = "";
    for (const [index, name] of segments.entries()) {
      const nodePath = parentPath ? `${parentPath}/${name}` : name;
      const kind = index === segments.length - 1 ? "file" : "directory";
      let node = children.find((candidate) => candidate.path === nodePath);
      if (!node) {
        node = {
          id: `${kind}:${nodePath}`,
          name,
          path: nodePath,
          kind,
          dirty: kind === "file" && buffers[path]?.current !== buffers[path]?.head,
          selected: kind === "file" && path === selectedPath,
          ...(kind === "directory" ? { children: [] } : { onOpen: () => onOpen(path) }),
        };
        children.push(node);
      }
      children = node.children as RepoTreeNode[];
      parentPath = nodePath;
    }
  }
  sortTree(roots);
  return roots;
}

function sortTree(nodes: RepoTreeNode[]) {
  nodes.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  for (const node of nodes) if (node.children) sortTree(node.children as RepoTreeNode[]);
}

function directoryIds(nodes: RepoTreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "directory"
      ? [node.id, ...directoryIds((node.children || []) as RepoTreeNode[])]
      : [],
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
  workbench: { flex: 1, minHeight: 0 },
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
  editorHeader: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  editorPath: { flex: 1, color: colors.text, fontFamily: "Menlo", fontSize: 11 },
  editorActions: { flexDirection: "row", gap: spacing.sm },
  headerAction: { color: colors.textMuted, fontSize: 11 },
  deleteAction: { color: colors.danger, fontSize: 11 },
  drawerToggle: { color: colors.text, fontFamily: "Menlo", fontSize: 15, fontWeight: "800" },
  drawer: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    zIndex: 20,
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRightColor: colors.border,
    borderRightWidth: 1,
    shadowColor: "#000",
    shadowOpacity: 0.55,
    shadowRadius: 16,
    elevation: 16,
  },
  drawerRail: {
    width: 48,
    alignItems: "center",
    paddingTop: spacing.sm,
    gap: spacing.xs,
    backgroundColor: colors.background,
    borderRightColor: colors.border,
    borderRightWidth: 1,
  },
  railButton: {
    width: 40,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderLeftColor: "transparent",
    borderLeftWidth: 2,
  },
  railButtonActive: { backgroundColor: colors.surfaceRaised, borderLeftColor: colors.accent },
  badge: {
    position: "absolute",
    right: 2,
    top: 2,
    minWidth: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  badgeText: { color: "#07120f", fontSize: 9, fontWeight: "900" },
  drawerContent: { flex: 1, minWidth: 0 },
  drawerHeader: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  drawerEyebrow: { color: colors.textFaint, fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },
  drawerTitle: { color: colors.text, fontSize: 14, fontWeight: "800", marginTop: 2 },
  drawerPanel: { flex: 1, minHeight: 0 },
  search: {
    color: colors.text,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    margin: spacing.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 12,
  },
  treeFrame: { flex: 1, minHeight: 0, paddingHorizontal: spacing.xs },
  treeRow: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingRight: 8,
    borderRadius: radius.sm,
  },
  treeRowSelected: { backgroundColor: "#233b35" },
  treeName: { flex: 1, color: colors.text, fontFamily: "Menlo", fontSize: 12 },
  dirtyDot: { color: colors.accent, fontSize: 10 },
  createBar: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.sm,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  createInput: {
    flex: 1,
    color: colors.text,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontFamily: "Menlo",
    fontSize: 12,
  },
  smallButton: {
    width: 38,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.sm,
  },
  commitForm: {
    gap: spacing.sm,
    padding: spacing.sm,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  commitInput: {
    color: colors.text,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 12,
  },
  commitButton: {
    minHeight: 38,
    flexDirection: "row",
    gap: 7,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
  },
  commitButtonText: { color: "#07120f", fontSize: 12, fontWeight: "800" },
  buttonDisabled: { opacity: 0.35 },
  changeHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 5,
  },
  changeCount: { color: colors.textMuted, fontFamily: "Menlo", fontSize: 11 },
  changeList: { paddingHorizontal: spacing.sm, paddingBottom: spacing.md },
  changeRow: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.sm,
  },
  changePathButton: { flex: 1 },
  changePath: { color: colors.text, fontFamily: "Menlo", fontSize: 11 },
  changeKind: {
    width: 12,
    color: colors.accent,
    fontFamily: "Menlo",
    fontSize: 11,
    fontWeight: "800",
  },
  outlineButton: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  buttonText: { color: colors.text, fontSize: 12 },
});
