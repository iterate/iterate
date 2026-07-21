// Chat list — the app's home screen once signed in. Adapted from the
// voice-ios-app branch (PR #1605) apps/mobile/src/app/project/[projectId]/index.tsx;
// divergences: lists the UNFILTERED /agents catalogue (web, slack, mobile —
// same as the dashboard sidebar; any chat can be opened and continued from
// here regardless of where it started) and "New chat" opens an empty thread
// instead of a voice session.

import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { ProjectDrawerButton } from "../../../components/project-drawer.tsx";
import { newMobileAgentPath } from "../../../lib/chat.ts";
import { getProjectItx } from "../../../lib/itx.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { enrollPushDevice } from "../../../lib/push-device.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

export default function ChatListScreen() {
  const { projectId, slug } = useLocalSearchParams<{ projectId: string; slug?: string }>();

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
          <ActivityIndicator color={colors.textMuted} />
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
              <Text style={styles.path}>{agent.path.replace(/^\/agents\//, "")}</Text>
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
