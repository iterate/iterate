// Project picker. Adapted from the voice-ios-app branch (PR #1605)
// apps/mobile/src/app/projects.tsx; divergences: selecting a project persists
// it as the boot destination, sign-out also tears down live thread
// subscriptions, and opening a project backfills a missing OS-side bootstrap
// first (see lib/open-project.ts).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { ProjectListEntry } from "../../../os/src/itx-api.generated.ts";
import { SignInRequiredError, signOut } from "../lib/auth.ts";
import { getItxSession, resetItxSession } from "../lib/itx.ts";
import { stopAllApprovals } from "../lib/live-approvals.ts";
import { stopAllThreads } from "../lib/live-thread.ts";
import { backfillProjectIfMissing } from "../lib/open-project.ts";
import { DEFAULT_SERVER } from "../lib/servers.ts";
import { getServerBaseUrl, setLastProject } from "../lib/storage.ts";
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
        // Redirect from the async failure, not render: render-time
        // navigation re-fires on every re-render while the error persists.
        if (error instanceof SignInRequiredError) router.replace("/");
        throw error;
      }
    },
  });

  const open = useMutation({
    mutationFn: async (project: ProjectListEntry) => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const itx = await getItxSession(baseUrl);
      await backfillProjectIfMissing(itx, project);
      await setLastProject(baseUrl, { id: project.id, slug: project.slug });
      return project;
    },
    onSuccess: (project) => {
      router.push({
        pathname: "/project/[projectId]",
        params: { projectId: project.id, slug: project.slug },
      });
    },
  });

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
                stopAllThreads();
                stopAllApprovals();
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
      {open.isError ? <Text style={styles.error}>{String(open.error.message)}</Text> : null}
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
          renderItem={({ item: project }) => {
            const pending = open.isPending && open.variables?.id === project.id;
            return (
              <Pressable
                style={[styles.row, pending && styles.rowPending]}
                disabled={pending}
                onPress={() => open.mutate(project)}
              >
                <Text style={styles.slug}>{project.slug}</Text>
                {project.organizationName ? (
                  <Text style={styles.org}>{project.organizationName}</Text>
                ) : null}
                {pending ? <Text style={styles.org}>Opening…</Text> : null}
              </Pressable>
            );
          }}
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
  rowPending: { opacity: 0.5 },
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
