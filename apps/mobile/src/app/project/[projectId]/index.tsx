import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { getItxSession, resetItxSession } from "../../../lib/itx.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

const VOICE_AGENT_PREFIX = "/agents/voice/";

export default function SessionsScreen() {
  const { projectId, slug } = useLocalSearchParams<{ projectId: string; slug?: string }>();

  const sessions = useQuery({
    queryKey: ["voice-sessions", projectId],
    queryFn: async () => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      try {
        const itx = await getItxSession(baseUrl);
        const project = await itx.projects.get(projectId);
        const agents = await project.agents.list();
        return agents
          .filter((agent) => agent.path.startsWith(VOICE_AGENT_PREFIX))
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      } catch (error) {
        resetItxSession();
        throw error;
      }
    },
  });

  const openVoice = (agentPath: string) =>
    router.push({
      pathname: "/project/[projectId]/voice",
      params: { projectId, slug: slug || "", path: agentPath },
    });

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: slug || "Sessions" }} />
      <Pressable
        style={styles.newSession}
        onPress={() => openVoice(`${VOICE_AGENT_PREFIX}${sessionSlug(new Date())}`)}
      >
        <Text style={styles.newSessionText}>Start a voice session</Text>
      </Pressable>

      {sessions.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : sessions.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>{String(sessions.error.message)}</Text>
          <Pressable onPress={() => sessions.refetch()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={sessions.data}
          keyExtractor={(agent) => agent.path}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          ListHeaderComponent={
            sessions.data.length > 0 ? (
              <Text style={styles.past}>
                Past sessions — reopening one resumes the worker&apos;s memory of it
              </Text>
            ) : null
          }
          ListEmptyComponent={
            <Text style={styles.empty}>No voice sessions in this project yet.</Text>
          }
          refreshing={sessions.isRefetching}
          onRefresh={() => sessions.refetch()}
          renderItem={({ item: agent }) => (
            <Pressable style={styles.row} onPress={() => openVoice(agent.path)}>
              <Text style={styles.path}>{agent.path.slice(VOICE_AGENT_PREFIX.length)}</Text>
              <Text style={styles.date}>{new Date(agent.createdAt).toLocaleString()}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

/** Same convention as the dashboard voice page: timestamp → agent path slug. */
function sessionSlug(date: Date) {
  return date
    .toISOString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
  newSession: {
    backgroundColor: colors.text,
    borderRadius: radius.md,
    margin: spacing.md,
    marginBottom: 0,
    alignItems: "center",
    paddingVertical: 14,
  },
  newSessionText: { color: colors.background, fontSize: 16, fontWeight: "600" },
  past: { color: colors.textFaint, fontSize: 12, marginBottom: spacing.sm },
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
