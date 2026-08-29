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
// A `seed` param opens the composer with text already in it but UNSENT — how
// /notes starts a conversation about a note.
//
// A brand-new chat is just this screen pointed at a fresh /agents/mobile/<ts>
// path: reading lazily initializes the underlying stream, but the platform
// requires an explicit agent.create() before the first message lands
// (stream processor births are explicit, not implicit-on-first-append) —
// the send mutation calls it unconditionally, same as the dashboard's
// new-chat page (routes/.../agents/new.tsx); it's idempotent so it's a
// harmless no-op when reopening an already-created chat from the list.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RpcStub } from "capnweb";
import type { Agent, StreamEvent } from "iterate/sdk/itx/react";
import {
  ActivityCard,
  CodeBlock,
  WorkingCard,
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
import { awaitingAgentActivity, latestAgentTitle } from "../../../lib/chat.ts";
import { photoFrame, photoFrameMaxWidth, PHOTO_MAX_HEIGHT } from "../../../lib/photo-layout.ts";
import { getProjectItx } from "../../../lib/itx.ts";
// APPROVAL_STREAM_EVENT_TYPES is module-level (identity-stable) on purpose:
// useLiveEvents folds eventTypes into its connection-hook deps, so an inline
// literal (fresh identity every render) would tear down and reopen the
// stream connection in a render loop.
import {
  APPROVAL_STREAM_EVENT_TYPES,
  deriveOpenBatches,
  readAllApprovalEvents,
} from "../../../lib/approvals.ts";
import { approverKeyStatus } from "../../../lib/approver.ts";
import { InThreadApprovalCard } from "../../../components/in-thread-approval.tsx";
import { VoiceCallChatButton } from "../../../components/voice-call-button.tsx";
import { useClaimReplyPresented } from "../../../lib/reply-presented.ts";
import { useLiveEvents } from "../../../lib/use-live-events.ts";
import { parseVoiceMarkup } from "../../../lib/voice-markup.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { buildStreamViewerUrl } from "../../../lib/stream-url.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

export default function ChatScreen() {
  const { projectId, slug, path, seed } = useLocalSearchParams<{
    projectId: string;
    slug?: string;
    path: string;
    /** Text to open the composer with, unsent. The /notes screen uses it to
     * hand a note-chat its pointer to the note (lib/notes.ts noteChatSeed) —
     * the question underneath it is the human's to write. */
    seed?: string;
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

  // While this screen shows the newest reply to a foregrounded user, claim
  // it so the reply push stays quiet (suppression, not read-state).
  useClaimReplyPresented({ baseUrl, events: events.data || [], path, projectId });

  // Approvals live on the project ROOT stream; a held batch whose
  // script-execution provenance names THIS thread renders as a dialog inside
  // the conversation (same query key as the Approvals screen — shared cache).
  const approvalEvents = useLiveEvents({
    queryKey: ["approval-events", baseUrl || "pending", projectId],
    read: async () => {
      const project = await getProjectItx(baseUrl!, projectId);
      return await readAllApprovalEvents(project.streams.get("/"));
    },
    enabled: baseUrl !== undefined,
    eventTypes: APPROVAL_STREAM_EVENT_TYPES,
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

  const [draft, setDraft] = useState(seed || "");
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
        const event = await agent.message(input.message);
        return event.offset;
      }
      // Same shape as the web composer: ONE addFiles call → one input event
      // carrying every attachment → one feed message + one agent turn.
      const added = await agent.addFiles({
        files: input.files.map((file) => ({
          contentType: file.contentType,
          data: base64ToUint8Array(file.base64),
          filename: file.filename,
        })),
        ...(input.message && { message: input.message }),
      });
      return added.event.offset;
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
  const sendPending =
    send.isPending || (send.data ? awaitingAgentActivity(events.data || [], send.data) : false);
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
          // Agent-set title once the first-turn summary lands; the raw path
          // (still one tap away in the ••• menu) until then.
          title: latestAgentTitle(events.data || []) || path.replace(/^\/agents\//, ""),
          headerRight: () => (
            <View style={styles.headerActions}>
              {/* Call this chat: its agent becomes the voice call's backend
                  and the conversation lands right here in the thread. Voice
                  machinery streams (lines, voice-notes desks) are not
                  callable — calling a desk wires a voice line to another
                  voice line's backend, a hall of mirrors that ate an
                  afternoon (2026-08-29). */}
              {baseUrl && !path.startsWith("/agents/voice") ? (
                <VoiceCallChatButton baseUrl={baseUrl} path={path} projectId={projectId} />
              ) : null}
              <Pressable
                accessibilityLabel="Stream actions"
                accessibilityRole="button"
                onPress={showStreamMenu}
                style={styles.streamMenu}
              >
                <Text style={styles.modeToggle}>•••</Text>
              </Pressable>
            </View>
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
          sendPending={sendPending}
          // The Meta tab replays each llm request's exact prompt from the
          // thread's own event window (same pure fold as the os trace panel).
          threadEvents={events.data || []}
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
          onPress={async () =>
            setAttachments([...attachments, ...(await pickImages({ selectionLimit: 6 }))])
          }
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
  threadEvents,
}: {
  activityApprovals: ActivityApprovalContext;
  approvals: React.ReactNode;
  feed: ReturnType<typeof reduceFeed>;
  sendPending: boolean;
  threadEvents: StreamEvent[];
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
          {/* working with no live steps covers BOTH owed-turn gaps: a live
              activity with no steps yet, and the pending-turn debounce
              window where no live activity exists at all (feed.ts
              turnPending). Rendered as the SAME card the live activity uses,
              so the box doesn't jump when the real card takes over. */}
          {sendPending || (feed.working && (feed.live === null || feed.live.steps.length === 0)) ? (
            <WorkingCard />
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
      renderItem={({ item }) => (
        <FeedItem
          activityApprovals={activityApprovals}
          item={item}
          liveStatus={item.id === feed.live?.id ? feed.liveStatus : null}
          threadEvents={threadEvents}
        />
      )}
    />
  );
}

function FeedItem({
  activityApprovals,
  item,
  liveStatus,
  threadEvents,
}: {
  activityApprovals: ActivityApprovalContext;
  item: MobileFeedItem;
  liveStatus: ReturnType<typeof reduceFeed>["liveStatus"];
  threadEvents: StreamEvent[];
}) {
  switch (item.kind) {
    case "activity":
      return (
        <ActivityCard
          activity={item}
          approvals={activityApprovals}
          liveStatus={liveStatus}
          threadEvents={threadEvents}
        />
      );
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
  const voice = parseVoiceMarkup(message.text);
  const window = useWindowDimensions();
  /* Spoken turns copied from a voice call: the person's side renders like
   * their normal messages and the voice's side like the bot's — both in
   * italics so a glance separates said from typed (on-device feedback,
   * 2026-08-29). The reducer sees developer rows; the SIDE comes from the
   * tag's speaker, not the item kind. */
  if (voice?.kind === "turn") {
    const person = voice.speaker === "person";
    return (
      <View style={[styles.bubble, person ? styles.bubbleUser : styles.bubbleAssistant]}>
        <View style={styles.bubbleTextInset}>
          <Text
            style={[person ? styles.bubbleUserText : styles.voiceAssistantText, styles.voiceText]}
            selectable
          >
            {voice.text}
            {voice.interrupted ? " —" : ""}
          </Text>
        </View>
      </View>
    );
  }
  /* A note the frontend sent its backend mid-call: machinery worth having
   * on the record, not a message anybody typed — collapsed to one row. */
  if (voice?.kind === "note") return <VoiceNoteRow id={message.id} text={voice.text} />;
  const isUser = message.kind === "user";
  // A photo frame is exactly this wide, while a bubble would otherwise grow to
  // 85% of the screen — so a caption longer than the photo would stretch the
  // bubble past it and reopen the gap at the photo's edge. Cap the caption at
  // the frame's width and the bubble stays the photo's size.
  const photoWidth = message.files?.some((file) => file.contentType.startsWith("image/"))
    ? photoFrameMaxWidth(window.width)
    : null;
  return (
    <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
      {/* Photos above their caption, the way every chat app puts them — and
          the bubble carries no padding of its own, so a photo reaches its
          edges instead of floating in a frame. Text brings its own inset. */}
      {message.files?.map((file) => (
        <MessageAttachment key={file.path} file={file} />
      ))}
      {message.text !== "" ? (
        <View
          style={[styles.bubbleTextInset, photoWidth === null ? null : { maxWidth: photoWidth }]}
        >
          {isUser ? (
            <Text style={styles.bubbleUserText} selectable>
              {message.text}
            </Text>
          ) : (
            <Markdown markdown={message.text} />
          )}
        </View>
      ) : null}
    </View>
  );
}

/** One tappable row for a frontend→backend voice note, collapsed by
 * default — the query cache holds the toggle (no useState, composer
 * precedent), keyed per item so each note expands alone. */
function VoiceNoteRow({ id, text }: { id: string; text: string }) {
  const cache = useQueryClient();
  const { data: open } = useQuery<boolean>({
    queryKey: ["voice-note-open", id],
    queryFn: () => false,
    staleTime: Infinity,
    initialData: false,
  });
  return (
    <Pressable
      accessibilityLabel={open ? "Collapse voice note" : "Expand voice note"}
      accessibilityRole="button"
      onPress={() => cache.setQueryData(["voice-note-open", id], !open)}
      style={styles.voiceNoteRow}
    >
      <Text numberOfLines={open ? undefined : 1} style={styles.voiceNoteText}>
        🎙 note to backend{open ? `\n${text}` : ` · ${text}`}
      </Text>
    </Pressable>
  );
}

function MessageAttachment({ file }: { file: AgentUiFileAttachment }) {
  // Signed public URL minted when the file was attached — same source the
  // web's <img> and the LLM use.
  const open = () => void WebBrowser.openBrowserAsync(file.url);
  if (file.contentType.startsWith("image/")) return <MessagePhoto file={file} onPress={open} />;
  return (
    <Pressable onPress={open} style={styles.fileChip}>
      <Text style={styles.fileChipText} numberOfLines={1}>
        📎 {file.filename} · {formatFileSize(file.size)}
      </Text>
    </Pressable>
  );
}

/** Photo attachments, Telegram-style: flush to the bubble's edges at their own
 * aspect ratio, and — when a tall screenshot hits the height cap and no longer
 * fills the frame — sitting on a blurred copy of themselves rather than black
 * bars. Frame maths and its reasoning: lib/photo-layout.ts. */
function MessagePhoto({ file, onPress }: { file: AgentUiFileAttachment; onPress: () => void }) {
  const window = useWindowDimensions();
  // Dimensions come from the loaded image, not the attachment record (which
  // carries none) — one lookup per URL, cached for the thread's lifetime.
  const natural = useQuery({
    queryKey: ["image-size", file.url],
    queryFn: () =>
      new Promise<{ height: number; width: number }>((resolve, reject) =>
        Image.getSize(file.url, (width, height) => resolve({ height, width }), reject),
      ),
    staleTime: Infinity,
    retry: false,
  });
  const frame = photoFrame({
    maxHeight: PHOTO_MAX_HEIGHT,
    maxWidth: photoFrameMaxWidth(window.width),
    natural: natural.data,
  });
  return (
    <Pressable
      accessibilityLabel={file.filename}
      onPress={onPress}
      style={{ height: frame.height, width: frame.width }}
    >
      {natural.data === undefined ? (
        // Until the image reports its dimensions the frame is a plain box at a
        // guessed aspect ratio. Say so: it is a real loading state, a screen
        // reader should announce it, and it is what the spec's spinner waiter
        // holds its budget open on instead of racing the first paint.
        <View accessibilityLabel="Loading" style={StyleSheet.absoluteFill} />
      ) : null}
      {frame.backdrop ? (
        <Image
          source={{ uri: file.url }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          blurRadius={18}
          testID="photo-backdrop"
        />
      ) : null}
      <Image source={{ uri: file.url }} style={StyleSheet.absoluteFill} resizeMode="contain" />
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
  headerActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
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
    // No padding, and clipped: a photo child fills the bubble corner to
    // corner. Text children inset themselves (bubbleTextInset).
    gap: 2,
    overflow: "hidden",
  },
  bubbleTextInset: { paddingHorizontal: spacing.md, paddingVertical: 10 },
  bubbleUser: { alignSelf: "flex-end", backgroundColor: colors.text },
  bubbleAssistant: {
    alignSelf: "flex-start",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
  },
  bubbleUserText: { color: colors.background, fontSize: 15, lineHeight: 21 },
  bubbleAssistantText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  voiceText: { fontStyle: "italic" },
  voiceAssistantText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  voiceNoteRow: {
    alignSelf: "flex-start",
    maxWidth: "85%",
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
  },
  voiceNoteText: { color: colors.textMuted, fontSize: 12, fontStyle: "italic" },
  bottomStack: { gap: spacing.sm },
  eventRow: { gap: 4 },
  eventType: { color: colors.textFaint, fontSize: 11, fontFamily: "Menlo" },
  wakeMarker: { color: colors.textFaint, fontSize: 11, textAlign: "center" },
  fileChip: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    marginHorizontal: spacing.md,
    marginVertical: 4,
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
