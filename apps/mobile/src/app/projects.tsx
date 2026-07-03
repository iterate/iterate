import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SignInRequiredError, signOut } from "../lib/auth.ts";
import { getItxSession, resetItxSession } from "../lib/itx.ts";
import { DEFAULT_SERVER } from "../lib/servers.ts";
import { getServerBaseUrl } from "../lib/storage.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

export default function ProjectsScreen() {
  const queryClient = useQueryClient();
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: async () => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      try {
        const itx = await getItxSession(baseUrl);
        const list = await itx.projects.list({ scope: "mine" });
        return { baseUrl, list };
      } catch (error) {
        resetItxSession();
        throw error;
      }
    },
  });

  if (projects.error instanceof SignInRequiredError) {
    router.replace("/");
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: "Projects",
          headerRight: () => (
            <Pressable
              onPress={async () => {
                const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
                await signOut(baseUrl);
                resetItxSession();
                queryClient.clear();
                router.replace("/");
              }}
            >
              <Text style={styles.signOut}>Sign out</Text>
            </Pressable>
          ),
        }}
      />
      {projects.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : projects.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>{String(projects.error.message)}</Text>
          <Pressable onPress={() => projects.refetch()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={projects.data.list}
          keyExtractor={(project) => project.id}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          ListHeaderComponent={
            <Text style={styles.server}>{projects.data.baseUrl.replace(/^https?:\/\//, "")}</Text>
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              No projects on this account. Create one from the dashboard, then pull to refresh.
            </Text>
          }
          refreshing={projects.isRefetching}
          onRefresh={() => projects.refetch()}
          renderItem={({ item: project }) => (
            <Pressable
              style={styles.row}
              onPress={() =>
                router.push({
                  pathname: "/project/[projectId]",
                  params: { projectId: project.id, slug: project.slug },
                })
              }
            >
              <Text style={styles.slug}>{project.slug}</Text>
              {project.organizationName ? (
                <Text style={styles.org}>{project.organizationName}</Text>
              ) : null}
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
  server: { color: colors.textFaint, fontSize: 12, marginBottom: spacing.sm },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 2,
  },
  slug: { color: colors.text, fontSize: 16, fontWeight: "600" },
  org: { color: colors.textMuted, fontSize: 13 },
  empty: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  error: { color: colors.danger, fontSize: 14, textAlign: "center" },
  retry: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: { color: colors.text, fontSize: 14 },
  signOut: { color: colors.textMuted, fontSize: 14 },
});
