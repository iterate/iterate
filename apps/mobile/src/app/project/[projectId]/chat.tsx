// Chat thread — one agent stream rendered as a feed. The heart of the app.
//
// Data flow: useLiveEvents reads the stream, then uses iterate/sdk/itx/react's
// useStreamConnection to feed server-pushed batches into the same query cache.
// Sending appends to the agent stream over itx (the same lane the web dashboard
// uses); the echo of our own message and everything the agent does arrive
// through the connection.
//
// Rendering runs the SAME reduction as the web dashboard (packages/ui
// agent-ui-reducer via lib/feed.ts): user/assistant bubbles plus activity
// roll-ups whose thinking/code text streams token-by-token while the agent
// works. A header toggle flips to the raw event feed for debugging.
//
// A brand-new chat is just this screen pointed at a fresh /agents/mobile/<ts>
// path: reading lazily initializes the underlying stream, but the platform
// requires an explicit agent.create() before the first message lands
// (stream processor births are explicit, not implicit-on-first-append) —
// the send mutation calls it unconditionally, same as the dashboard's
// new-chat page (routes/.../agents/new.tsx); it's idempotent so it's a
// harmless no-op when reopening an already-created chat from the list.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Clipboard,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RpcStub } from "capnweb";
import type { Agent, StreamEvent } from "iterate/sdk/itx/react";
import {
  ActivityCard,
  CodeBlock,
  type ActivityApprovalContext,
} from "../../../components/activity-card.tsx";
import { Markdown } from "../../../components/markdown.tsx";
import { base64ToUint8Array, pickImages, type PickedImage } from "../../../lib/attachments.ts";
import { SignInRequiredError } from "../../../lib/auth.ts";
import {
  collapseConsecutiveStreamWakes,
  reduceFeed,
  type AgentUiFileAttachment,
  type AgentUiMessageItem,
  type MobileFeedItem,
} from "../../../lib/feed.ts";
import { getProjectItx } from "../../../lib/itx.ts";
import { deriveOpenBatches, EVENT as APPROVAL_EVENT } from "../../../lib/approvals.ts";

// Module-level constant on purpose: useLiveEvents folds eventTypes into its
// connection-hook deps, so an inline literal (fresh identity every render)
// would tear down and reopen the stream connection in a render loop.
const APPROVAL_EVENT_TYPES = [
  APPROVAL_EVENT.requested,
  APPROVAL_EVENT.decided,
  APPROVAL_EVENT.settled,
];
import { approverKeyStatus } from "../../../lib/approver.ts";
import { InThreadApprovalCard } from "../../../components/in-thread-approval.tsx";
import { useLiveEvents } from "../../../lib/use-live-events.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { buildStreamViewerUrl } from "../../../lib/stream-url.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

export default function ChatScreen() {
  const { projectId, slug, path } = useLocalSearchParams<{
    projectId: string;
    slug?: string;
    path: string;
  }>();

  // The thread query is keyed by base URL (live pushes land under the same
  // key), so resolve it first; it's one keychain read.
  const server = useQuery({
    queryKey: ["server"],
    queryFn: async () => (await getServerBaseUrl()) || DEFAULT_SERVER,
    staleTime: Infinity,
  });
  const baseUrl = server.data;

  const events = useLiveEvents({
    queryKey: ["thread-events", baseUrl || "", projectId, path],
    read: async () => {
      try {
        const project = await getProjectItx(baseUrl!, projectId);
        return await project.streams.get(path).getEvents({});
      } catch (error) {
        // Redirect from the async failure, not render: render-time
        // navigation re-fires on every re-render while the error persists.
        if (error instanceof SignInRequiredError) router.replace("/");
        throw error;
      }
    },
    enabled: baseUrl !== undefined,
    eventTypes: undefined,
    projectId,
    streamPath: path,
  });

  // Approvals live on the project ROOT stream; a held batch whose
  // script-execution provenance names THIS thread renders as a dialog inside
  // the conversation (same query key as the Approvals screen — shared cache).
  const approvalEvents = useLiveEvents({
    queryKey: ["approval-events", baseUrl || "pending", projectId],
    read: async () => {
      const project = await getProjectItx(baseUrl!, projectId);
      return await project.streams.get("/").getEvents({ eventTypes: APPROVAL_EVENT_TYPES });
    },
    enabled: baseUrl !== undefined,
    eventTypes: APPROVAL_EVENT_TYPES,
    projectId,
    streamPath: "/",
  });
  const threadBatches = deriveOpenBatches(approvalEvents.data || []).filter(
    (batch) =>
      batch.payload.streamContext?.kind === "script-execution" &&
      batch.payload.streamContext.streamPath === path,
  );
  const approverKey = useQuery({
    queryKey: ["approver-key-status", projectId, baseUrl],
    queryFn: () => approverKeyStatus(baseUrl!, projectId),
    enabled: baseUrl !== undefined,
  });

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PickedImage[]>([]);
  const [viewMode, setViewMode] = useState<"chat" | "events">("chat");
  const copyStreamUrl = useMutation({
    mutationFn: async (url: string) => Clipboard.setString(url),
    onSuccess: () => {
      setTimeout(() => copyStreamUrl.reset(), 1_800);
    },
  });
  const send = useMutation({
    mutationFn: async (input: { message: string; files: PickedImage[] }) => {
      const project = await getProjectItx(baseUrl!, projectId);
      const agent = project.agents.get(path) as RpcStub<Agent>;
      // create() is idempotent (its birth events carry deterministic
      // idempotency keys), so this is safe whether `path` is a brand-new
      // chat or an already-created one opened from the list — the platform
      // requires an explicit create() before the first message either way.
      await agent.create();
      if (input.files.length === 0) {
        await agent.message(input.message);
        return;
      }
      // Same shape as the web composer: ONE addFiles call → one input event
      // carrying every attachment → one feed message + one agent turn.
      await agent.addFiles({
        files: input.files.map((file) => ({
          contentType: file.contentType,
          data: base64ToUint8Array(file.base64),
          filename: file.filename,
        })),
        ...(input.message ? { message: input.message } : {}),
      });
    },
    onMutate: () => {
      setDraft("");
      setAttachments([]);
    },
    onError: (_error, input) => {
      setDraft(input.message);
      setAttachments(input.files);
    },
  });

  const feed = reduceFeed(path, events.data || []);
  const insets = useSafeAreaInsets();
  const streamUrl =
    baseUrl && slug ? buildStreamViewerUrl({ baseUrl, projectSlug: slug, streamPath: path }) : null;

  const runStreamAction = (action: string) => {
    if (action === "Show raw events") setViewMode("events");
    if (action === "Show chat") setViewMode("chat");
    if (action === "Copy stream URL" && streamUrl) {
      copyStreamUrl.mutate(streamUrl);
    }
    if (action === "Open stream in browser" && streamUrl) {
      void WebBrowser.openBrowserAsync(streamUrl);
    }
  };
  const showStreamMenu = () => {
    const options = [
      viewMode === "chat" ? "Show raw events" : "Show chat",
      ...(streamUrl ? ["Copy stream URL", "Open stream in browser"] : []),
      "Cancel",
    ];
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { cancelButtonIndex: options.length - 1, options, title: path },
        (index) => runStreamAction(options[index] || "Cancel"),
      );
      return;
    }
    Alert.alert(
      path,
      undefined,
      options.map((option) => ({
        onPress: () => runStreamAction(option),
        style: option === "Cancel" ? "cancel" : "default",
        text: option,
      })),
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={100}
    >
      <Stack.Screen
        options={{
          title: path.replace(/^\/agents\//, ""),
          headerRight: () => (
            <Pressable
              accessibilityLabel="Stream actions"
              accessibilityRole="button"
              onPress={showStreamMenu}
              style={styles.streamMenu}
            >
              <Text style={styles.modeToggle}>•••</Text>
            </Pressable>
          ),
        }}
      />
      {events.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} />
        </View>
      ) : events.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>{String(events.error.message)}</Text>
          <Pressable onPress={() => events.refetch()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : viewMode === "chat" ? (
        <FeedList
          approvals={
            baseUrl === undefined
              ? null
              : threadBatches.map((batch) => (
                  <InThreadApprovalCard
                    baseUrl={baseUrl}
                    batch={batch}
                    canApprove={approverKey.data?.kind === "enrolled"}
                    key={batch.offset}
                    projectId={projectId}
                  />
                ))
          }
          feed={feed}
          // The card's Approvals tab and status glyphs derive from the same
          // live root-stream approval events the in-thread dialogs use.
          activityApprovals={{
            baseUrl: baseUrl!,
            events: approvalEvents.data || [],
            projectId,
            projectSlug: slug || "",
          }}
          sendPending={send.isPending}
        />
      ) : (
        <EventList events={events.data || []} />
      )}

      {attachments.length > 0 ? (
        <View style={styles.attachmentStrip}>
          {attachments.map((image) => (
            <Pressable
              key={image.previewUri}
              onPress={() =>
                setAttachments(attachments.filter((a) => a.previewUri !== image.previewUri))
              }
            >
              <Image source={{ uri: image.previewUri }} style={styles.attachmentThumb} />
              <Text style={styles.attachmentRemove}>✕</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        <Pressable
          onPress={async () => setAttachments([...attachments, ...(await pickImages())])}
          disabled={send.isPending}
          style={styles.attach}
        >
          <Text style={styles.attachText}>+</Text>
        </Pressable>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          placeholder="Message"
          placeholderTextColor={colors.textFaint}
          style={styles.input}
        />
        <Pressable
          accessibilityLabel="Send"
          accessibilityRole="button"
          onPress={() => {
            const message = draft.trim();
            const canSend = message !== "" || attachments.length > 0;
            if (canSend && !send.isPending) send.mutate({ message, files: attachments });
          }}
          disabled={(draft.trim() === "" && attachments.length === 0) || send.isPending}
          style={[
            styles.send,
            ((draft.trim() === "" && attachments.length === 0) || send.isPending) && {
              opacity: 0.4,
            },
          ]}
        >
          <Text style={styles.sendText}>↑</Text>
        </Pressable>
      </View>
      {send.isError ? (
        <Text style={styles.sendError}>
          {send.error instanceof Error ? send.error.message : String(send.error)}
        </Text>
      ) : null}
      {copyStreamUrl.isSuccess ? (
        <View
          accessibilityLiveRegion="polite"
          accessibilityRole="alert"
          pointerEvents="none"
          style={[styles.toast, { bottom: Math.max(insets.bottom, spacing.sm) + 68 }]}
        >
          <Text style={styles.toastText}>Stream URL copied</Text>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

function FeedList({
  activityApprovals,
  approvals,
  feed,
  sendPending,
}: {
  activityApprovals: ActivityApprovalContext;
  approvals: React.ReactNode;
  feed: ReturnType<typeof reduceFeed>;
  sendPending: boolean;
}) {
  // Inverted list keeps the newest item at the bottom and pinned on keyboard
  // open; data is reversed to match. The live activity is part of the feed,
  // so streaming updates scroll naturally.
  const rows = collapseConsecutiveStreamWakes(feed.items).reverse();
  return (
    <FlatList
      inverted
      data={rows}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
      ListHeaderComponent={
        // Inverted list: the "header" renders at the visual bottom — held
        // approval dialogs for THIS thread sit at the thread's bottom edge
        // (above the transient working row), right where the human is
        // already looking.
        <View style={styles.bottomStack}>
          {approvals}
          {sendPending || (feed.working && feed.live?.steps.length === 0) ? (
            <View style={styles.workingRow}>
              <ActivityIndicator accessibilityLabel="Loading" size="small" color={colors.working} />
              <Text style={styles.workingText}>working…</Text>
            </View>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        <View style={styles.emptyFlip}>
          <Text style={styles.empty}>
            Say what you want done. You&apos;ll see the agent think, write code, run it, and reply —
            all live.
          </Text>
        </View>
      }
      renderItem={({ item }) => <FeedItem activityApprovals={activityApprovals} item={item} />}
    />
  );
}

function FeedItem({
  activityApprovals,
  item,
}: {
  activityApprovals: ActivityApprovalContext;
  item: MobileFeedItem;
}) {
  switch (item.kind) {
    case "activity":
      return <ActivityCard activity={item} approvals={activityApprovals} />;
    case "stream-woken":
      return (
        <Text style={styles.wakeMarker}>
          — {item.text || "stream woke"}
          {item.wakeCount > 1 ? ` (${item.wakeCount})` : ""} —
        </Text>
      );
    case "processor-revived":
      return (
        <Text style={styles.wakeMarker}>
          — {item.processorSlug == null ? "processor" : `${item.processorSlug} processor`} revived —
        </Text>
      );
    case "child-stream-created":
      return <Text style={styles.wakeMarker}>— created child stream {item.childPath} —</Text>;
    case "stream-paused":
    case "stream-resumed":
      return (
        <Text style={styles.wakeMarker}>
          — {item.reason == null ? item.text : `${item.text}: ${item.reason}`} —
        </Text>
      );
    case "user":
    case "assistant":
      return <MessageBubble message={item} />;
  }
}

function MessageBubble({ message }: { message: AgentUiMessageItem }) {
  const isUser = message.kind === "user";
  return (
    <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
      {message.text !== "" ? (
        isUser ? (
          <Text style={styles.bubbleUserText} selectable>
            {message.text}
          </Text>
        ) : (
          <Markdown markdown={message.text} />
        )
      ) : null}
      {message.files?.map((file) => (
        <MessageAttachment key={file.path} file={file} />
      ))}
    </View>
  );
}

function MessageAttachment({ file }: { file: AgentUiFileAttachment }) {
  // Signed public URL minted when the file was attached — same source the
  // web's <img> and the LLM use.
  const open = () => void WebBrowser.openBrowserAsync(file.url);
  if (file.contentType.startsWith("image/")) {
    return (
      <Pressable onPress={open}>
        <Image source={{ uri: file.url }} style={styles.attachmentImage} resizeMode="contain" />
      </Pressable>
    );
  }
  return (
    <Pressable onPress={open} style={styles.fileChip}>
      <Text style={styles.fileChipText} numberOfLines={1}>
        📎 {file.filename} · {formatFileSize(file.size)}
      </Text>
    </Pressable>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The unreduced stream, newest first — the debugging view. */
function EventList({ events }: { events: StreamEvent[] }) {
  const rows = [...events].reverse();
  return (
    <FlatList
      inverted
      data={rows}
      keyExtractor={(event) => String(event.offset)}
      contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
      renderItem={({ item: event }) => (
        <View style={styles.eventRow}>
          <Text style={styles.eventType}>
            {event.offset} · {event.type.replace("events.iterate.com/", "")}
          </Text>
          {event.payload ? (
            <CodeBlock language="json" text={previewPayload(event.payload)} muted />
          ) : null}
        </View>
      )}
    />
  );
}

function previewPayload(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload, null, 1);
  return json.length > 800 ? `${json.slice(0, 800)}…` : json;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    padding: spacing.lg,
  },
  streamMenu: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radius.full,
    borderWidth: 1,
    height: 38,
    justifyContent: "center",
    width: 46,
  },
  modeToggle: { color: colors.textMuted, fontSize: 16, letterSpacing: 1 },
  emptyFlip: { transform: [{ scaleY: -1 }], padding: spacing.lg },
  empty: { color: colors.textMuted, fontSize: 14, lineHeight: 20, textAlign: "center" },
  error: { color: colors.danger, fontSize: 14, textAlign: "center" },
  retry: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: { color: colors.text, fontSize: 14 },
  bubble: {
    maxWidth: "85%",
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  bubbleUser: { alignSelf: "flex-end", backgroundColor: colors.text },
  bubbleAssistant: {
    alignSelf: "flex-start",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
  },
  bubbleUserText: { color: colors.background, fontSize: 15, lineHeight: 21 },
  bubbleAssistantText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  bottomStack: { gap: spacing.sm },
  workingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  workingText: { color: colors.working, fontSize: 13 },
  eventRow: { gap: 4 },
  eventType: { color: colors.textFaint, fontSize: 11, fontFamily: "Menlo" },
  wakeMarker: { color: colors.textFaint, fontSize: 11, textAlign: "center" },
  attachmentImage: {
    width: 220,
    height: 160,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
    marginTop: 4,
  },
  fileChip: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    marginTop: 4,
    alignSelf: "flex-start",
  },
  fileChipText: { color: colors.textMuted, fontSize: 12 },
  attachmentStrip: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  attachmentThumb: {
    width: 52,
    height: 52,
    borderRadius: radius.sm,
    borderColor: colors.border,
    borderWidth: 1,
  },
  attachmentRemove: {
    position: "absolute",
    top: -6,
    right: -6,
    color: colors.text,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.full,
    width: 18,
    height: 18,
    textAlign: "center",
    fontSize: 11,
    lineHeight: 17,
    overflow: "hidden",
  },
  attach: {
    width: 38,
    height: 38,
    borderRadius: radius.full,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  attachText: { color: colors.textMuted, fontSize: 20, lineHeight: 22 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    color: colors.text,
    fontSize: 15,
    maxHeight: 120,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  send: {
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  sendText: { color: colors.background, fontSize: 18, fontWeight: "700" },
  sendError: {
    color: colors.danger,
    fontSize: 12,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  toast: {
    position: "absolute",
    left: spacing.xl,
    right: spacing.xl,
    zIndex: 20,
    alignItems: "center",
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  toastText: { color: colors.text, fontSize: 13, fontWeight: "600" },
});
