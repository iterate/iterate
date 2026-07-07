// Chat thread — one agent stream rendered as a feed. The heart of the app.
//
// Data flow: loadAndFollowThread (lib/live-thread.ts) reads the stream's
// events and keeps a live server-push subscription feeding the same query
// cache, so this screen is a plain useQuery consumer. Sending appends to the
// agent stream over itx (the same lane the web dashboard uses); the echo of
// our own message and everything the agent does arrive through the
// subscription.
//
// Rendering runs the SAME reduction as the web dashboard (packages/ui
// agent-ui-reducer via lib/feed.ts): user/assistant bubbles plus activity
// roll-ups whose thinking/code text streams token-by-token while the agent
// works. A header toggle flips to the raw event feed for debugging.
//
// A brand-new chat is just this screen pointed at a fresh /agents/mobile/<ts>
// path: reading lazily initializes the stream and the first send creates the
// agent (same lazy-seeding contract as the dashboard's new-chat page).

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActivityCard, CodeBlock } from "../../../components/activity-card.tsx";
import { SignInRequiredError } from "../../../lib/auth.ts";
import { reduceFeed, type AgentUiItem, type AgentUiMessageItem } from "../../../lib/feed.ts";
import { getItxSession, resetItxSession } from "../../../lib/itx.ts";
import { loadAndFollowThread, threadQueryKey } from "../../../lib/live-thread.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import type { StreamEvent } from "../../../../../os/src/types.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

export default function ChatScreen() {
  const { projectId, path } = useLocalSearchParams<{
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

  const events = useQuery({
    queryKey: threadQueryKey(baseUrl || "", projectId, path),
    queryFn: async () => {
      try {
        return await loadAndFollowThread(baseUrl!, projectId, path);
      } catch (error) {
        resetItxSession();
        throw error;
      }
    },
    enabled: baseUrl !== undefined,
    // The live subscription owns updates after the initial load.
    staleTime: Infinity,
  });

  const [draft, setDraft] = useState("");
  const [viewMode, setViewMode] = useState<"chat" | "events">("chat");
  const send = useMutation({
    mutationFn: async (message: string) => {
      const itx = await getItxSession(baseUrl!);
      const project = await itx.projects.get(projectId);
      await project.agents.get(path).sendMessage(message);
    },
    onMutate: () => setDraft(""),
    onError: (_error, message) => setDraft(message),
  });

  if (events.error instanceof SignInRequiredError) {
    router.replace("/");
  }

  const feed = reduceFeed(path, events.data || []);
  const insets = useSafeAreaInsets();

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
            <Pressable onPress={() => setViewMode(viewMode === "chat" ? "events" : "chat")}>
              <Text style={styles.modeToggle}>{viewMode === "chat" ? "raw" : "chat"}</Text>
            </Pressable>
          ),
        }}
      />
      {events.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : events.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>{String(events.error.message)}</Text>
          <Pressable onPress={() => events.refetch()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : viewMode === "chat" ? (
        <FeedList feed={feed} sendPending={send.isPending} />
      ) : (
        <EventList events={events.data || []} />
      )}

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          placeholder="Message"
          placeholderTextColor={colors.textFaint}
          style={styles.input}
        />
        <Pressable
          onPress={() => {
            const message = draft.trim();
            if (message !== "" && !send.isPending) send.mutate(message);
          }}
          disabled={draft.trim() === "" || send.isPending}
          style={[styles.send, (draft.trim() === "" || send.isPending) && { opacity: 0.4 }]}
        >
          <Text style={styles.sendText}>↑</Text>
        </Pressable>
      </View>
      {send.isError ? (
        <Text style={styles.sendError}>
          {send.error instanceof Error ? send.error.message : String(send.error)}
        </Text>
      ) : null}
    </KeyboardAvoidingView>
  );
}

function FeedList({
  feed,
  sendPending,
}: {
  feed: ReturnType<typeof reduceFeed>;
  sendPending: boolean;
}) {
  // Inverted list keeps the newest item at the bottom and pinned on keyboard
  // open; data is reversed to match. The live activity is part of the feed,
  // so streaming updates scroll naturally.
  const rows = [...feed.items].reverse();
  return (
    <FlatList
      inverted
      data={rows}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
      ListHeaderComponent={
        // Inverted list: the "header" renders at the visual bottom.
        sendPending || (feed.working && feed.live?.steps.length === 0) ? (
          <View style={styles.workingRow}>
            <ActivityIndicator size="small" color={colors.working} />
            <Text style={styles.workingText}>working…</Text>
          </View>
        ) : null
      }
      ListEmptyComponent={
        <View style={styles.emptyFlip}>
          <Text style={styles.empty}>
            Say what you want done. You&apos;ll see the agent think, write code, run it, and reply —
            all live.
          </Text>
        </View>
      }
      renderItem={({ item }) => <FeedItem item={item} />}
    />
  );
}

function FeedItem({ item }: { item: AgentUiItem }) {
  if (item.kind === "activity") return <ActivityCard activity={item} />;
  return <MessageBubble message={item} />;
}

function MessageBubble({ message }: { message: AgentUiMessageItem }) {
  const isUser = message.kind === "user";
  return (
    <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
      <Text style={isUser ? styles.bubbleUserText : styles.bubbleAssistantText} selectable>
        {message.text}
      </Text>
    </View>
  );
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
          {event.payload ? <CodeBlock text={previewPayload(event.payload)} muted /> : null}
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
  modeToggle: { color: colors.textMuted, fontSize: 14 },
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
});
