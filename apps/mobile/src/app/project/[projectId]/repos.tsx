import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { ProjectDrawerButton } from "../../../components/project-drawer.tsx";
import { getProjectItx } from "../../../lib/itx.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

export default function ReposScreen() {
  const { projectId, slug } = useLocalSearchParams<{ projectId: string; slug?: string }>();
  const repos = useQuery({
    queryKey: ["repos", projectId],
    queryFn: async () => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const project = await getProjectItx(baseUrl, projectId);
      const rows = await project.repos.list();
      return [...rows].sort((left, right) => {
        if (left.path === "/repos/config") return -1;
        if (right.path === "/repos/config") return 1;
        return left.path.localeCompare(right.path);
      });
    },
  });

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: "/repos",
          headerLeft: () => (
            <ProjectDrawerButton projectId={projectId} projectSlug={slug || "Repos"} />
          ),
        }}
      />
      {repos.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} />
        </View>
      ) : repos.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>{repos.error.message}</Text>
          <Pressable onPress={() => repos.refetch()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          contentContainerStyle={styles.list}
          data={repos.data}
          keyExtractor={(repo) => repo.path}
          ListEmptyComponent={<Text style={styles.empty}>This project has no repositories.</Text>}
          onRefresh={() => repos.refetch()}
          refreshing={repos.isRefetching}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                router.push({
                  pathname: "/project/[projectId]/repo",
                  params: { projectId, repoPath: item.path },
                })
              }
              style={styles.row}
            >
              <View style={styles.rowCopy}>
                <Text style={styles.name}>{item.path.replace(/^\/repos\//, "")}</Text>
                <Text style={styles.path}>{item.path}</Text>
              </View>
              {item.path === "/repos/config" ? <Text style={styles.primary}>PROJECT</Text> : null}
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  center: {
    alignItems: "center",
    flex: 1,
    gap: spacing.md,
    justifyContent: "center",
    padding: spacing.lg,
  },
  list: { gap: spacing.sm, padding: spacing.md },
  row: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    minHeight: 72,
    padding: spacing.md,
  },
  rowCopy: { flex: 1, gap: 3 },
  name: { color: colors.text, fontSize: 16, fontWeight: "700" },
  path: { color: colors.textMuted, fontFamily: "Menlo", fontSize: 11 },
  primary: { color: colors.accent, fontSize: 9, fontWeight: "800", letterSpacing: 0.7 },
  chevron: { color: colors.textFaint, fontSize: 24 },
  empty: { color: colors.textMuted, fontSize: 14, textAlign: "center" },
  error: { color: colors.danger, fontSize: 14, textAlign: "center" },
  retry: {
    borderColor: colors.border,
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: { color: colors.text, fontSize: 14 },
});
