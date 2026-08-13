// Chat list — the app's home screen once signed in. Adapted from the
// voice-ios-app branch (PR #1605) apps/mobile/src/app/project/[projectId]/index.tsx;
// divergences: lists the UNFILTERED /agents catalogue (web, slack, mobile —
// same as the dashboard sidebar; any chat can be opened and continued from
// here regardless of where it started) and "New chat" opens an empty thread
// instead of a voice session.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { ProjectDrawerButton } from "../../../components/project-drawer.tsx";
import { newMobileAgentPath } from "../../../lib/chat.ts";
import { getProjectItx } from "../../../lib/itx.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { ensureApproverKeyEnrolled } from "../../../lib/approver.ts";
import { enrollPushDevice } from "../../../lib/push-device.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

export default function ChatListScreen() {
  const { projectId, slug } = useLocalSearchParams<{ projectId: string; slug?: string }>();
  const queryClient = useQueryClient();

  const agents = useQuery({
    queryKey: ["agents", projectId],
    queryFn: async () => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const project = await getProjectItx(baseUrl, projectId);
      const list = await project.agents.list();
      return [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
  });
  const pushDevice = useQuery({
    queryKey: ["push-device", projectId],
    queryFn: async () => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      return await enrollPushDevice(baseUrl, projectId);
    },
    retry: false,
    refetchOnWindowFocus: "always",
  });
  // Opening a project silently enrolls this device's approval key (a
  // Keychain write never prompts Face ID) so held requests are approvable
  // the moment they appear — the approvals screen's enroll banner is now the
  // fallback, not the common path. Best-effort like the push enrollment: a
  // failure must not block the project, and the next open retries. A
  // successful enroll PRIMES the approvals screen's key-status query (same
  // key it reads) so its Approve button never flashes "Enroll to approve"
  // while re-deriving what this query just established.
  useQuery({
    queryKey: ["approver-key-enrollment", projectId],
    queryFn: async () => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const key = await ensureApproverKeyEnrolled(baseUrl, projectId);
      if (key !== null) {
        queryClient.setQueryData(["approver-key-status", projectId, baseUrl], {
          kind: "enrolled",
          key,
        });
      }
      return key;
    },
    retry: false,
  });

  const openChat = (agentPath: string) =>
    router.push({
      pathname: "/project/[projectId]/chat",
      params: { projectId, slug: slug || "", path: agentPath },
    });

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: slug || "Chats",
          headerLeft: () => (
            <ProjectDrawerButton projectId={projectId} projectSlug={slug || "Chats"} />
          ),
        }}
      />
      <Pressable style={styles.newChat} onPress={() => openChat(newMobileAgentPath(new Date()))}>
        <Text style={styles.newChatText}>New chat</Text>
      </Pressable>
      {pushDevice.isError ? (
        <Text style={styles.pushStatus}>
          Phone notifications unavailable: {pushDevice.error.message}
        </Text>
      ) : pushDevice.data ? (
        <Text style={styles.pushStatus}>This phone is available to project scripts.</Text>
      ) : null}

      {agents.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} />
        </View>
      ) : agents.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>{String(agents.error.message)}</Text>
          <Pressable onPress={() => agents.refetch()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={agents.data}
          keyExtractor={(agent) => agent.path}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          ListEmptyComponent={
            <Text style={styles.empty}>No chats in this project yet. Start one above.</Text>
          }
          refreshing={agents.isRefetching}
          onRefresh={() => agents.refetch()}
          renderItem={({ item: agent }) => (
            <Pressable style={styles.row} onPress={() => openChat(agent.path)}>
              <Text
                style={agent.title === undefined ? styles.path : styles.title}
                numberOfLines={2}
              >
                {agent.title || agent.path.replace(/^\/agents\//, "")}
              </Text>
              <Text style={styles.date}>{new Date(agent.createdAt).toLocaleString()}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
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
  newChat: {
    backgroundColor: colors.text,
    borderRadius: radius.md,
    margin: spacing.md,
    marginBottom: 0,
    alignItems: "center",
    paddingVertical: 14,
  },
  newChatText: { color: colors.background, fontSize: 16, fontWeight: "600" },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 2,
  },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  // Untitled chats (the agent has not set a summary title yet) fall back to
  // the raw stream path, shown in mono so it reads as an identifier.
  path: { color: colors.text, fontSize: 14, fontFamily: "Menlo" },
  date: { color: colors.textMuted, fontSize: 12 },
  empty: { color: colors.textMuted, fontSize: 14 },
  pushStatus: {
    color: colors.textMuted,
    fontSize: 12,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
  },
  error: { color: colors.danger, fontSize: 14, textAlign: "center" },
  retry: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: { color: colors.text, fontSize: 14 },
});
