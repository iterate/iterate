// Project picker. Adapted from the voice-ios-app branch (PR #1605)
// apps/mobile/src/app/projects.tsx; divergences: selecting a project persists
// it as the boot destination, and opening a project backfills a missing
// OS-side bootstrap first (see lib/open-project.ts). Shared subscription hooks
// own their teardown when sign-out replaces this route.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { ProjectListEntry } from "iterate/sdk/itx/react";
import { AppDrawerButton } from "../components/project-drawer.tsx";
import { SignInRequiredError, signOut } from "../lib/auth.ts";
import { disconnectItxSession, getItxSession } from "../lib/itx.ts";
import { backfillProjectIfMissing } from "../lib/open-project.ts";
import { revokeEnrolledPushDevices } from "../lib/push-device.ts";
import { DEFAULT_SERVER } from "../lib/servers.ts";
import { getServerBaseUrl, setLastProject } from "../lib/storage.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

export default function ProjectsScreen() {
  const queryClient = useQueryClient();
  // Set by the sign-in screen's post-login navigation: an account with
  // exactly one project skips the picker — a single-item list is a pointless
  // tap. Only fresh sign-ins carry it, so Back from a project (plain
  // /projects) always shows the picker.
  const { autoOpen } = useLocalSearchParams<{ autoOpen?: string }>();
  const projects = useQuery({
    queryKey: ["projects", { autoOpen: Boolean(autoOpen) }],
    queryFn: async () => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      try {
        const itx = await getItxSession(baseUrl);
        const list = await itx.projects.list({ scope: "mine" });
        // Navigate from the query, not render (same rationale as the
        // sign-in redirect below) — and from HERE rather than the sign-in
        // mutation so the cold-itx first list gets this query's retries.
        if (autoOpen && list.length === 1) {
          const project = list[0];
          await backfillProjectIfMissing(itx, project);
          await setLastProject(baseUrl, { id: project.id, slug: project.slug });
          router.replace({
            pathname: "/project/[projectId]",
            params: { projectId: project.id, slug: project.slug },
          });
        }
        return { baseUrl, list };
      } catch (error) {
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
          // Build info stays reachable before a project is picked.
          headerLeft: () => <AppDrawerButton />,
          headerRight: () => (
            <Pressable
              onPress={async () => {
                const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
                // Server-side cleanup is best-effort: an unreachable server
                // must never trap the user in a signed-in state.
                await revokeEnrolledPushDevices(baseUrl).catch((error) => {
                  console.log(`[auth] push revocation skipped on sign-out: ${String(error)}`);
                });
                await signOut(baseUrl);
                disconnectItxSession();
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
          <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} />
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
