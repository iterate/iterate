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
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Clipboard,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { RpcStub } from "capnweb";
import type { Agent, StreamEvent } from "iterate/sdk/itx/react";
import { mosaicLayout } from "@iterate-com/ui/lib/mosaic-layout";
import {
  ActivityCard,
  CodeBlock,
  WorkingCard,
  type ActivityApprovalContext,
} from "../../../components/activity-card.tsx";
import { Markdown } from "../../../components/markdown.tsx";
import { useDebouncedValue } from "../../../lib/use-debounced-value.ts";
import { AttachmentChips } from "../../../components/attachment-chips.tsx";
import { CrashGuard } from "../../../components/crash-guard.tsx";
import { AttachmentSheet } from "../../../components/attachment-sheet.tsx";
import { RecordControls } from "../../../components/record-controls.tsx";
import {
  attachmentAssetId,
  attachmentKey,
  attachmentUploads,
  describedAttachment,
  messageWithAttachmentParts,
  type ComposerAttachment,
} from "../../../lib/composer-attachments.ts";
import { LocationCard } from "../../../components/location-card.tsx";
import { MediaViewer } from "../../../components/media-viewer.tsx";
import { AudioMessagePlayer } from "../../../components/audio-player.tsx";
import { VideoTile } from "../../../components/video-attachment.tsx";
import { readFileBase64 } from "../../../lib/file-bytes.ts";
import { transcriptFor } from "../../../lib/voice-transcription.ts";
import { videoThumbnailQuery } from "../../../lib/video-thumbnails.ts";
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
import { getActiveCall } from "../../../lib/voice-call-session.ts";
import { useVoiceCallActive, useVoiceCallTarget } from "../../../lib/voice-call-state.ts";
import { parseVoiceMarkup } from "../../../lib/voice-markup.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { buildStreamViewerUrl } from "../../../lib/stream-url.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

export default function ChatScreenGuarded() {
  return (
    <CrashGuard label="chat">
      <ChatScreen />
    </CrashGuard>
  );
}

function ChatScreen() {
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
      // A dead sign-in drops back to the sign-in screen from the query
      // cache's error handler (lib/query.ts) — app-global, not per screen.
      const project = await getProjectItx(baseUrl!, projectId);
      return await project.streams.get(path).getEvents({});
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
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"chat" | "events">("chat");
  const appendAttachments = (added: ComposerAttachment[]) => {
    setAttachments((prev) => {
      const seen = new Set(prev.map(attachmentKey));
      return [...prev, ...added.filter((attachment) => !seen.has(attachmentKey(attachment)))];
    });
  };
  const copyStreamUrl = useMutation({
    mutationFn: async (url: string) => Clipboard.setString(url),
    onSuccess: () => {
      setTimeout(() => copyStreamUrl.reset(), 1_800);
    },
  });
  // Optimistic sends: the moment you hit ↑ the message renders as a real
  // bubble built from phone-local data (text, preview uris, dimensions) —
  // the upload happens behind it. The entry carries the event offset once
  // the platform accepts it, and hides as soon as that offset's echo arrives
  // over the live connection; a failure keeps the bubble with Retry/Edit
  // instead of dumping everything back into the composer.
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([]);
  const echoedOffsets = new Set((events.data || []).map((event) => event.offset));
  const visiblePending = pendingSends.filter(
    (pending) => pending.offset === undefined || !echoedOffsets.has(pending.offset),
  );
  const callActive = useVoiceCallActive();
  const callTarget = useVoiceCallTarget();
  const send = useMutation({
    mutationFn: async (input: {
      clientId: string;
      message: string;
      files: ComposerAttachment[];
    }) => {
      /* Typing to the chat you are CALLING is switching modalities: hang
       * up first, or the still-live voice narrates every reply into your
       * pocket and sprays spoken-turn copies through this thread
       * (observed 2026-08-29 — the "hang up" had only minimised the
       * sheet, and the call ran on until the idle reaper). */
      if (callActive && callTarget?.colleaguePath === path) {
        await getActiveCall()?.hangUp();
      }
      // Recorded clips pick up their on-device transcript (started at attach
      // time; wait briefly for a straggler) so it rides the <voice-note>
      // part the agent reads.
      const files = await Promise.all(
        input.files.map(async (attachment) =>
          attachment.kind === "audio" &&
          attachment.durationSeconds !== null &&
          attachment.transcript === null
            ? { ...attachment, transcript: await transcriptFor(attachment.uri, 4_000) }
            : attachment,
        ),
      );
      // The optimistic bubble gets the hydrated transcripts too — the words
      // appear under the waveform while the upload is still running.
      setPendingSends((prev) =>
        prev.map((pending) =>
          pending.clientId === input.clientId ? { ...pending, files } : pending,
        ),
      );
      // Byte-carrying attachments become addFiles payloads (bytes read
      // lazily from their local uris here, at send time); location becomes
      // an XML part appended to the text (lib/composer-attachments.ts).
      const uploads = await attachmentUploads(files, readFileBase64);
      const message = messageWithAttachmentParts(input.message, files);
      const project = await getProjectItx(baseUrl!, projectId);
      const agent = project.agents.get(path) as RpcStub<Agent>;
      // create() is idempotent (its birth events carry deterministic
      // idempotency keys), so this is safe whether `path` is a brand-new
      // chat or an already-created one opened from the list — the platform
      // requires an explicit create() before the first message either way.
      await agent.create();
      if (uploads.length === 0) {
        const event = await agent.message(message);
        return event.offset;
      }
      // Same shape as the web composer: ONE addFiles call → one input event
      // carrying every attachment → one feed message + one agent turn.
      const added = await agent.addFiles({
        files: uploads,
        ...(message && { message }),
      });
      return added.event.offset;
    },
    onMutate: (input) => {
      setDraft("");
      setAttachments([]);
      setPendingSends((prev) => {
        // Echoed entries have done their job; a retry reuses its clientId.
        const kept = prev.filter(
          (pending) =>
            pending.clientId !== input.clientId &&
            (pending.offset === undefined || !echoedOffsets.has(pending.offset)),
        );
        return [
          ...kept,
          {
            clientId: input.clientId,
            files: input.files,
            message: input.message,
            sentAtMs: Date.now(),
            status: "sending",
          },
        ];
      });
    },
    onSuccess: (offset, input) => {
      setPendingSends((prev) =>
        prev.map((pending) =>
          pending.clientId === input.clientId ? { ...pending, offset } : pending,
        ),
      );
    },
    onError: (error, input) => {
      setPendingSends((prev) =>
        prev.map((pending) =>
          pending.clientId === input.clientId
            ? {
                ...pending,
                error: error instanceof Error ? error.message : String(error),
                status: "failed" as const,
              }
            : pending,
        ),
      );
    },
  });

  const feed = reduceFeed(path, events.data || []);
  // The pending bubble covers the upload window; the working card takes over
  // once the platform has the message and the agent owes a turn.
  const sendPending = send.data ? awaitingAgentActivity(events.data || [], send.data) : false;
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
      <View style={styles.feedArea}>
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
            pending={visiblePending.map((entry) => (
              <PendingSendBubble
                entry={entry}
                key={entry.clientId}
                onEdit={() => {
                  setPendingSends((prev) =>
                    prev.filter((pending) => pending.clientId !== entry.clientId),
                  );
                  setDraft(entry.message);
                  setAttachments(entry.files);
                }}
                onRetry={() =>
                  send.mutate({
                    clientId: entry.clientId,
                    message: entry.message,
                    files: entry.files,
                  })
                }
              />
            ))}
            sendPending={sendPending}
            // The Meta tab replays each llm request's exact prompt from the
            // thread's own event window (same pure fold as the os trace panel).
            threadEvents={events.data || []}
          />
        ) : (
          <EventList events={events.data || []} />
        )}
        {sheetOpen ? (
          // Drawer semantics for the attachment sheet: any tap on the
          // conversation above it dismisses, like tapping a sheet's backdrop.
          <Pressable
            accessibilityLabel="Dismiss attachment options"
            onPress={() => setSheetOpen(false)}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
      </View>

      {/* Chips ABOVE the sheet, sheet ABOVE the input: attaching from the
          open sheet grows the chips row upward into feed space, so neither
          the sheet nor the input row ever shifts mid-interaction. (The
          chips drop down when the sheet closes — fine.) */}
      <AttachmentChips
        attachments={attachments}
        onRemove={(key) =>
          setAttachments((prev) => prev.filter((attachment) => attachmentKey(attachment) !== key))
        }
      />
      {sheetOpen ? (
        <AttachmentSheet
          attachedAssetIds={attachments.flatMap((attachment) => {
            const assetId = attachmentAssetId(attachment);
            return assetId === null ? [] : [assetId];
          })}
          onAttach={appendAttachments}
          onDetachAsset={(assetId) =>
            setAttachments((prev) =>
              prev.filter((attachment) => attachmentAssetId(attachment) !== assetId),
            )
          }
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        <Pressable
          accessibilityLabel={sheetOpen ? "Close attachment options" : "Attach something"}
          accessibilityRole="button"
          onPress={() => setSheetOpen(!sheetOpen)}
          style={styles.attach}
        >
          <Text style={[styles.attachText, sheetOpen && styles.attachTextOpen]}>+</Text>
        </Pressable>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          placeholder="Message"
          placeholderTextColor={colors.textFaint}
          style={styles.input}
        />
        {draft.trim() !== "" || attachments.length > 0 || Platform.OS === "web" ? (
          <Pressable
            accessibilityLabel="Send"
            accessibilityRole="button"
            onPress={() => {
              const message = draft.trim();
              if (message !== "" || attachments.length > 0) {
                // Fire-and-render: the optimistic bubble appears immediately
                // and further sends can queue behind it.
                send.mutate({
                  clientId: Math.random().toString(36).slice(2, 10),
                  message,
                  files: attachments,
                });
              }
            }}
            disabled={draft.trim() === "" && attachments.length === 0}
            style={[
              styles.send,
              draft.trim() === "" && attachments.length === 0 && { opacity: 0.4 },
            ]}
          >
            <Text style={styles.sendText}>↑</Text>
          </Pressable>
        ) : (
          // Empty composer on a capable build: the Telegram-style mic/video
          // hold-to-record button takes the send slot.
          <RecordControls onAttach={(attachment) => appendAttachments([attachment])} />
        )}
      </View>
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
  pending,
  sendPending,
  threadEvents,
}: {
  activityApprovals: ActivityApprovalContext;
  approvals: React.ReactNode;
  feed: ReturnType<typeof reduceFeed>;
  /** Optimistic just-sent bubbles, newest last — they sit directly under the
   * real messages, above any approval dialogs. */
  pending: React.ReactNode;
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
          {pending}
          {approvals}
          {/* working with no live steps covers BOTH owed-turn gaps: a live
              activity with no steps yet, and the pending-turn debounce
              window where no live activity exists at all (feed.ts
              turnPending). Rendered as the SAME card the live activity uses,
              so the box doesn't jump when the real card takes over. */}
          {sendPending || (feed.working && (feed.live === null || feed.live.steps.length === 0)) ? (
            <WorkingCard label="working…" />
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
  // Displayed phase lags the derived one by a 250ms quiet window so
  // sub-100ms journal ripples can't flash the glyph (see the hook). The
  // content key treats phase + statusText as one display identity.
  const debouncedLiveStatus = useDebouncedValue({
    scope: item.id,
    contentKey: liveStatus === null ? null : `${liveStatus.phase}|${liveStatus.statusText || ""}`,
    value: liveStatus,
    debounceMs: 250,
  });
  switch (item.kind) {
    case "activity":
      return (
        <ActivityCard
          activity={item}
          approvals={activityApprovals}
          liveStatus={debouncedLiveStatus}
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

/** One optimistic send: everything needed to render the predicted bubble
 * from phone-local data, plus enough to retry or re-edit a failure. */
type PendingSend = {
  clientId: string;
  files: ComposerAttachment[];
  message: string;
  sentAtMs: number;
  status: "sending" | "failed";
  error?: string;
  offset?: number;
};

/** The predicted bubble for a send in flight: the SAME MessageBubble the
 * echo will render, fed local uris instead of signed urls (previews, players,
 * mosaic and location cards all work on local files), slightly dimmed with a
 * status line under it. Failure keeps the bubble and offers Retry / Edit —
 * nothing gets dumped back into the composer. */
function PendingSendBubble({
  entry,
  onEdit,
  onRetry,
}: {
  entry: PendingSend;
  onEdit: () => void;
  onRetry: () => void;
}) {
  // While the send is in flight, a recorded clip whose transcription hasn't
  // landed yet shows "Transcribing…" in the transcript slot — the mutation
  // swaps in the real words as soon as hydration resolves.
  const displayFiles =
    entry.status === "sending"
      ? entry.files.map((attachment) =>
          attachment.kind === "audio" &&
          attachment.durationSeconds !== null &&
          attachment.transcript === null
            ? { ...attachment, transcript: "Transcribing…" }
            : attachment,
        )
      : entry.files;
  const message: AgentUiMessageItem = {
    kind: "user",
    id: `pending-${entry.clientId}`,
    text: entry.message,
    // Local derivation for the optimistic bubble: same mapping the wire
    // parts come from, so the pending render matches the settled one.
    attachments: displayFiles.flatMap((attachment) => {
      const described = describedAttachment(attachment);
      return described === null ? [] : [described];
    }),
    timestampMs: entry.sentAtMs,
    files: entry.files.flatMap((attachment): AgentUiFileAttachment[] => {
      const key = attachmentKey(attachment);
      if (attachment.kind === "location") return []; // rides in the text
      if (attachment.kind === "photo") {
        return [
          {
            contentType: attachment.image.contentType,
            filename: attachment.image.filename,
            path: key,
            size: 0,
            url: attachment.image.previewUri,
          },
        ];
      }
      return [
        {
          contentType: attachment.contentType,
          filename: attachment.filename,
          path: key,
          size: attachment.kind === "audio" ? 0 : attachment.sizeBytes || 0,
          url: attachment.uri,
        },
      ];
    }),
  };
  return (
    <View style={[styles.pendingWrap, entry.status === "sending" ? styles.pendingSending : null]}>
      <MessageBubble message={message} />
      {entry.status === "sending" ? (
        // The SAME card working… renders in — identical box, so nothing
        // jumps when the echo lands and the working card takes this spot.
        <WorkingCard label="sending…" />
      ) : (
        <View style={styles.pendingFailedRow}>
          <Text numberOfLines={2} style={styles.pendingError}>
            {entry.error || "Couldn't send"}
          </Text>
          <Pressable accessibilityRole="button" hitSlop={8} onPress={onRetry}>
            <Text style={styles.pendingAction}>Retry</Text>
          </Pressable>
          <Pressable accessibilityRole="button" hitSlop={8} onPress={onEdit}>
            <Text style={styles.pendingAction}>Edit</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function MessageBubble({ message }: { message: AgentUiMessageItem }) {
  const voice = parseVoiceMarkup(message.text);
  const window = useWindowDimensions();
  // Hooks above the voice-turn early returns (rules of hooks): tapped photos
  // open the in-app viewer (components/media-viewer.tsx) on the SAME uri the
  // bubble already rendered — instant from the image cache, with pinch-zoom
  // and swipe-down, instead of a browser page reloading it.
  const [viewingImage, setViewingImage] = useState<AgentUiFileAttachment | null>(null);
  /* Spoken turns copied from a voice call: the person's side renders like
   * their normal messages and the voice's side like the bot's — both in
   * italics so a glance separates said from typed (on-device feedback,
   * 2026-08-29). The reducer sees developer rows; the SIDE comes from the
   * tag's speaker, not the item kind. */
  if (voice?.kind === "turn") {
    /* A spoken turn the facet stamped as machinery — reading the backend's
     * reply aloud, a status aside — collapses: the substance is already in
     * the thread as the backend's own message right beside it. The stamp
     * comes from the FACET (it knows what drew each answer); the backend
     * model tags nothing (asking it to proved unreliable — it kept tagging
     * an hour after the call died, 2026-08-29). */
    if (voice.speaker === "assistant" && voice.spokenKind !== null) {
      return (
        <VoiceNoteRow
          id={message.id}
          label={voice.spokenKind === "status" ? "status aside" : "said aloud"}
          text={voice.text}
        />
      );
    }
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
  /* Call machinery worth having on the record, not conversation: a note
   * the frontend sent its backend, or the backend's tagged reply (whose
   * words the caller already heard as the spoken turn beside it) —
   * collapsed to one row each. */
  if (voice?.kind === "note") {
    return <VoiceNoteRow id={message.id} label="note to backend" text={voice.text} />;
  }
  if (voice?.kind === "reply") {
    return <VoiceNoteRow id={message.id} label="backend replied" text={voice.text} />;
  }
  const isUser = message.kind === "user";
  // A photo frame is exactly this wide, while a bubble would otherwise grow to
  // 85% of the screen — so a caption longer than the photo would stretch the
  // bubble past it and reopen the gap at the photo's edge. Cap the caption at
  // the frame's width and the bubble stays the photo's size.
  const isMedia = (file: AgentUiFileAttachment) =>
    file.contentType.startsWith("image/") || file.contentType.startsWith("video/");
  const media = (message.files || []).filter(isMedia);
  const audios = (message.files || []).filter((file) => file.contentType.startsWith("audio/"));
  const otherFiles = (message.files || []).filter(
    (file) => !isMedia(file) && !file.contentType.startsWith("audio/"),
  );
  // Typed attachment metadata comes from the fold (a derivation processor
  // parsed the composer's html parts into message.attachments — dims size
  // frames before bytes load, transcripts sit under waveforms, locations
  // become map cards). A message nothing described renders its raw text: no
  // client-side format parsing, by design.
  const knownDimensions: KnownDimensions = {};
  const transcripts: Record<string, string> = {};
  const locations: {
    latitude: number;
    longitude: number;
    accuracyMeters: number | null;
    capturedAt: string;
  }[] = [];
  for (const attachment of message.attachments || []) {
    if (
      (attachment.kind === "image" || attachment.kind === "video") &&
      attachment.width !== undefined &&
      attachment.height !== undefined
    ) {
      knownDimensions[attachment.filename] = {
        width: attachment.width,
        height: attachment.height,
      };
    }
    if (attachment.kind === "audio" && attachment.transcript !== undefined) {
      transcripts[attachment.filename] = attachment.transcript;
    }
    if (attachment.kind === "location") {
      locations.push({
        latitude: attachment.latitude,
        longitude: attachment.longitude,
        accuracyMeters: attachment.accuracyMeters === undefined ? null : attachment.accuracyMeters,
        capturedAt: attachment.capturedAt || "",
      });
    }
  }
  const photoWidth =
    media.length > 0 || audios.length > 0 || locations.length > 0
      ? photoFrameMaxWidth(window.width)
      : null;
  const caption = message.text;
  return (
    <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
      {/* Media above the caption, the way every chat app puts it — and the
          bubble carries no padding of its own, so a photo reaches its edges
          instead of floating in a frame. Text brings its own inset. Two or
          more photos/videos share a Telegram-style mosaic instead of
          stacking full-width (lib/mosaic-layout.ts); videos wear a play
          badge and open full screen. */}
      {media.length >= 2 ? (
        <MessageMosaic
          files={media}
          knownDimensions={knownDimensions}
          onViewImage={setViewingImage}
        />
      ) : media.length === 1 && media[0]!.contentType.startsWith("video/") ? (
        <SingleVideoFrame file={media[0]!} knownDimensions={knownDimensions} />
      ) : (
        media.map((file) => (
          <MessagePhoto
            file={file}
            key={file.path}
            knownDimensions={knownDimensions}
            onPress={() => setViewingImage(file)}
          />
        ))
      )}
      {audios.map((file) => (
        <AudioMessagePlayer
          file={file}
          key={file.path}
          tone={isUser ? "onLight" : "onDark"}
          transcript={transcripts[file.filename] || null}
          width={photoFrameMaxWidth(window.width)}
        />
      ))}
      {otherFiles.map((file) => (
        <MessageAttachment
          file={file}
          key={file.path}
          tone={isUser ? "onLight" : "onDark"}
          width={photoFrameMaxWidth(window.width)}
        />
      ))}
      {locations.map((location) => (
        <LocationCard
          key={location.capturedAt}
          location={location}
          width={photoFrameMaxWidth(window.width)}
        />
      ))}
      {caption !== "" ? (
        <View
          style={[styles.bubbleTextInset, photoWidth === null ? null : { maxWidth: photoWidth }]}
        >
          {isUser ? (
            <Text style={styles.bubbleUserText} selectable>
              {caption}
            </Text>
          ) : (
            <Markdown markdown={caption} />
          )}
        </View>
      ) : null}
      {/* animationType none: the fade used to show ~300ms of the viewer's
          near-black backdrop before the (already cached) image painted —
          instant open reads as the thumbnail expanding instead. */}
      <Modal
        animationType="none"
        onRequestClose={() => setViewingImage(null)}
        statusBarTranslucent
        transparent
        visible={viewingImage !== null}
      >
        {viewingImage ? (
          <MediaViewer
            markdown=""
            onClose={() => setViewingImage(null)}
            tags={[]}
            title={viewingImage.filename}
            uri={viewingImage.url}
          />
        ) : null}
      </Modal>
    </View>
  );
}

/** One tappable row for a frontend→backend voice note, collapsed by
 * default — the query cache holds the toggle (no useState, composer
 * precedent), keyed per item so each note expands alone. */
function VoiceNoteRow({ id, label, text }: { id: string; label: string; text: string }) {
  const cache = useQueryClient();
  const { data: open } = useQuery<boolean>({
    queryKey: ["voice-note-open", id],
    queryFn: () => false,
    staleTime: Infinity,
    initialData: false,
  });
  return (
    <Pressable
      accessibilityLabel={open ? `Collapse ${label}` : `Expand ${label}`}
      accessibilityRole="button"
      onPress={() => cache.setQueryData(["voice-note-open", id], !open)}
      style={styles.voiceNoteRow}
    >
      <Text numberOfLines={open ? undefined : 1} style={styles.voiceNoteText}>
        🎙 {label}
        {open ? `\n${text}` : ` · ${text}`}
      </Text>
    </Pressable>
  );
}

/** Non-media files as a media-row sibling of the voice-note player: same
 * height and width, file glyph where the play button is, filename where the
 * waveform goes, size + type where the time goes. Tapping opens the signed
 * public URL (same source the web's <img> and the LLM use). */
function MessageAttachment({
  file,
  tone,
  width,
}: {
  file: AgentUiFileAttachment;
  tone: "onLight" | "onDark";
  width: number;
}) {
  const palette =
    tone === "onLight"
      ? { circle: colors.background, glyph: colors.text, name: colors.background }
      : { circle: colors.text, glyph: colors.background, name: colors.text };
  const extension = file.filename.split(".").at(-1);
  const meta = [
    file.size > 0 ? formatFileSize(file.size) : null,
    extension && extension !== file.filename ? extension.toUpperCase() : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <Pressable
      accessibilityLabel={`Open file ${file.filename}`}
      accessibilityRole="button"
      onPress={() => void WebBrowser.openBrowserAsync(file.url)}
      style={[styles.fileRow, { width }]}
    >
      <View style={[styles.fileGlyph, { backgroundColor: palette.circle }]}>
        <Ionicons name="document-outline" size={18} color={palette.glyph} />
      </View>
      <View style={styles.fileColumn}>
        <Text numberOfLines={1} style={[styles.fileName, { color: palette.name }]}>
          {file.filename}
        </Text>
        {meta !== "" ? <Text style={styles.fileMeta}>{meta}</Text> : null}
      </View>
    </Pressable>
  );
}

/** Two-or-more photos in one message: the justified-rows mosaic
 * (lib/mosaic-layout.ts) — photos share rows at a common height, cropped to
 * cover their tiles, instead of stacking full-width. Sizes come from the
 * same per-URL cache MessagePhoto uses — but a message whose composer sent
 * <attachment .../> dimension parts lays out right the first time, no
 * reflow; only dimensionless files fall back to measuring and one reflow. */
function MessageMosaic({
  files,
  knownDimensions,
  onViewImage,
}: {
  files: AgentUiFileAttachment[];
  knownDimensions: KnownDimensions;
  onViewImage: (file: AgentUiFileAttachment) => void;
}) {
  const window = useWindowDimensions();
  const sizes = useQueries({
    // Photos measure via Image.getSize; videos via their extracted
    // first-frame thumbnail. Either way the composer's dimension part wins.
    queries: files.map((file) =>
      file.contentType.startsWith("video/")
        ? videoThumbnailQuery(file.url)
        : imageSizeQuery(file.url),
    ),
  });
  const naturalOf = (file: AgentUiFileAttachment, index: number) =>
    knownDimensions[file.filename] || sizes[index]?.data || undefined;
  const layout = mosaicLayout({
    aspectRatios: files.map((file, index) => {
      const natural = naturalOf(file, index);
      return natural === undefined ? 1 : natural.width / natural.height;
    }),
    maxWidth: photoFrameMaxWidth(window.width),
  });
  return (
    <View style={{ height: layout.height, width: layout.width }}>
      {files.map((file, index) => {
        const rect = layout.rects[index]!;
        const rectStyle = {
          position: "absolute" as const,
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
        };
        if (file.contentType.startsWith("video/")) {
          return <VideoTile file={file} key={file.path} style={rectStyle} />;
        }
        return (
          <Pressable
            accessibilityLabel={file.filename}
            key={file.path}
            onPress={() => onViewImage(file)}
            style={rectStyle}
          >
            {naturalOf(file, index) === undefined ? (
              // Real loading UI, not a guess: the spec's spinner waiter holds
              // on this instead of racing the reflow (MessagePhoto precedent).
              <View accessibilityLabel="Loading" style={StyleSheet.absoluteFill} />
            ) : null}
            <Image resizeMode="cover" source={{ uri: file.url }} style={StyleSheet.absoluteFill} />
          </Pressable>
        );
      })}
    </View>
  );
}

/** A lone video message: the photo frame's sizing rules (dimension part or
 * extracted thumbnail for the aspect ratio) around a VideoTile. */
function SingleVideoFrame({
  file,
  knownDimensions,
}: {
  file: AgentUiFileAttachment;
  knownDimensions: KnownDimensions;
}) {
  const window = useWindowDimensions();
  const thumbnail = useQuery(videoThumbnailQuery(file.url));
  const frame = photoFrame({
    maxHeight: PHOTO_MAX_HEIGHT,
    maxWidth: photoFrameMaxWidth(window.width),
    natural: knownDimensions[file.filename] || thumbnail.data || undefined,
  });
  return <VideoTile file={file} style={{ height: frame.height, width: frame.width }} />;
}

/** Photo attachments, Telegram-style: flush to the bubble's edges at their own
 * aspect ratio, and — when a tall screenshot hits the height cap and no longer
 * fills the frame — sitting on a blurred copy of themselves rather than black
 * bars. Frame maths and its reasoning: lib/photo-layout.ts. */
function MessagePhoto({
  file,
  knownDimensions,
  onPress,
}: {
  file: AgentUiFileAttachment;
  knownDimensions: KnownDimensions;
  onPress: () => void;
}) {
  const window = useWindowDimensions();
  // Dimensions come from the message's own <attachment .../> part when the
  // composer sent one; otherwise from the loaded image — one lookup per URL,
  // cached for the thread's lifetime.
  const sized = useQuery(imageSizeQuery(file.url));
  const natural = knownDimensions[file.filename] || sized.data;
  const frame = photoFrame({
    maxHeight: PHOTO_MAX_HEIGHT,
    maxWidth: photoFrameMaxWidth(window.width),
    natural,
  });
  return (
    <Pressable
      accessibilityLabel={file.filename}
      onPress={onPress}
      style={{ height: frame.height, width: frame.width }}
    >
      {natural === undefined ? (
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

type KnownDimensions = Record<string, { width: number; height: number }>;

/** One image-dimensions lookup per URL, cached for the thread's lifetime —
 * shared by the single-photo frame and the mosaic. */
function imageSizeQuery(url: string) {
  return {
    queryKey: ["image-size", url],
    queryFn: () =>
      new Promise<{ height: number; width: number }>((resolve, reject) =>
        Image.getSize(url, (width, height) => resolve({ height, width }), reject),
      ),
    staleTime: Infinity,
    retry: false,
  };
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
  feedArea: { flex: 1 },
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
  fileRow: {
    height: 56,
    minWidth: 200,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  fileGlyph: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  fileColumn: { flex: 1, gap: 3 },
  fileName: { fontSize: 14, fontWeight: "600" },
  fileMeta: { color: colors.textFaint, fontSize: 11 },
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
  // The + leans into a ✕ while the sheet is open — same control closes it.
  attachTextOpen: { color: colors.text, transform: [{ rotate: "45deg" }] },
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
  pendingWrap: { gap: spacing.sm },
  pendingSending: { opacity: 0.75 },
  pendingFailedRow: {
    alignSelf: "flex-end",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginTop: 2,
    maxWidth: "85%",
  },
  pendingError: { color: colors.danger, flexShrink: 1, fontSize: 11 },
  pendingAction: { color: colors.text, fontSize: 12, fontWeight: "600" },
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
