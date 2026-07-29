// Sign-in + server picker. Adapted from the voice-ios-app branch (PR #1605)
// apps/mobile/src/app/index.tsx; divergences: chat-first copy, preview-slot
// presets + persisted recent custom servers, and the boot path — with valid
// stored auth this screen immediately forwards to the remembered project's
// chat list (the whole point of the app is cold-open → typing in seconds).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Redirect, router, Stack } from "expo-router";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { hasSignIn, signIn } from "../lib/auth.ts";
import { getItxSession, reconnectItxSession } from "../lib/itx.ts";
import { backfillProjectIfMissing, rememberedProjectInScope } from "../lib/open-project.ts";
import { DEFAULT_SERVER, SERVER_PRESETS } from "../lib/servers.ts";
import {
  addRecentServer,
  clearLastProject,
  getLastProject,
  getRecentServers,
  getServerBaseUrl,
  setServerBaseUrl,
} from "../lib/storage.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

export default function SignInScreen() {
  const queryClient = useQueryClient();
  // Persisted server + sign-in state decide whether to skip this screen.
  const bootstrap = useQuery({
    queryKey: ["bootstrap"],
    queryFn: async () => {
      const server = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const signedIn = await hasSignIn(server);
      let lastProject = signedIn ? await getLastProject(server) : null;
      // The boot redirect below skips the project picker entirely — the
      // ONLY other place a project gets opened is projects.tsx's own tap
      // handler, which is exactly where backfillProjectIfMissing lives. A
      // returning session with a remembered project never goes through
      // that screen, so it needs its own backfill check here. A failed
      // verification falls back to the project picker instead of routing to
      // a project remembered under stale authorization.
      if (signedIn && lastProject) {
        try {
          const itx = await getItxSession(server);
          const entries = await itx.projects.list({ scope: "mine" });
          const remembered = rememberedProjectInScope(lastProject, entries);
          if (!remembered) {
            await clearLastProject(server);
            lastProject = null;
          } else {
            const entry = entries.find((candidate) => candidate.id === remembered.id)!;
            await backfillProjectIfMissing(itx, entry);
            lastProject = remembered;
          }
        } catch {
          // The project picker owns the visible retry/error state. Never
          // redirect to an unverified remembered project after a failed read.
          lastProject = null;
        }
      }
      return {
        server,
        signedIn,
        recents: await getRecentServers(),
        lastProject,
      };
    },
    staleTime: 0,
  });

  const [editedServer, setEditedServer] = useState<string | null>(null);
  const server = editedServer ?? bootstrap.data?.server ?? DEFAULT_SERVER;

  const login = useMutation({
    mutationFn: async () => {
      const baseUrl = normalizeBaseUrl(server);
      await setServerBaseUrl(baseUrl);
      if (!SERVER_PRESETS.some((preset) => preset.baseUrl === baseUrl)) {
        await addRecentServer(baseUrl);
      }
      await signIn(baseUrl);
      return baseUrl;
    },
    onSuccess: (baseUrl) => {
      setEditedServer(null);
      reconnectItxSession(baseUrl);
      queryClient.clear();
      router.replace("/projects");
    },
  });

  if (bootstrap.isPending) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} />
      </View>
    );
  }
  if (bootstrap.data?.signedIn && editedServer === null) {
    const last = bootstrap.data.lastProject;
    if (last) {
      return (
        <Redirect
          href={{
            pathname: "/project/[projectId]",
            params: { projectId: last.id, slug: last.slug },
          }}
        />
      );
    }
    return <Redirect href="/projects" />;
  }

  const serverOptions = [
    ...SERVER_PRESETS,
    ...(bootstrap.data?.recents || []).map((url) => ({
      label: url.replace(/^https?:\/\//, ""),
      baseUrl: url,
    })),
  ];

  return (
    <SafeAreaView style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.hero}>
        <Text style={styles.title}>Iterate</Text>
        <Text style={styles.subtitle}>
          Chat with your project&apos;s agents. Pick a deployment, sign in, start talking.
        </Text>
      </View>

      <View style={styles.form}>
        <Text style={styles.label}>Server</Text>
        <TextInput
          value={server}
          onChangeText={setEditedServer}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://os.iterate.com"
          placeholderTextColor={colors.textFaint}
          style={styles.input}
        />
        <View style={styles.chips}>
          {serverOptions.map((preset) => (
            <Pressable
              key={preset.baseUrl}
              accessibilityRole="button"
              onPress={() => setEditedServer(preset.baseUrl)}
              style={[styles.chip, server === preset.baseUrl && styles.chipActive]}
            >
              <Text style={[styles.chipText, server === preset.baseUrl && styles.chipTextActive]}>
                {preset.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => login.mutate()}
          disabled={login.isPending}
          style={[styles.signIn, login.isPending && { opacity: 0.6 }]}
        >
          {login.isPending ? (
            <ActivityIndicator accessibilityLabel="Loading" color={colors.background} />
          ) : (
            <Text style={styles.signInText}>Sign in</Text>
          )}
        </Pressable>
        {login.isError ? (
          <Text style={styles.error}>
            {login.error instanceof Error ? login.error.message : String(login.error)}
          </Text>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: spacing.lg },
  loading: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  hero: { flex: 1, justifyContent: "center", gap: spacing.md },
  title: { color: colors.text, fontSize: 34, fontWeight: "700", letterSpacing: -0.5 },
  subtitle: { color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  form: { gap: spacing.sm, paddingBottom: spacing.xl },
  label: { color: colors.textMuted, fontSize: 13 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  chips: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  chip: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: colors.surfaceRaised, borderColor: colors.textFaint },
  chipText: { color: colors.textMuted, fontSize: 13 },
  chipTextActive: { color: colors.text },
  signIn: {
    backgroundColor: colors.text,
    borderRadius: radius.md,
    alignItems: "center",
    paddingVertical: 14,
    marginTop: spacing.md,
  },
  signInText: { color: colors.background, fontSize: 16, fontWeight: "600" },
  error: { color: colors.danger, fontSize: 13, marginTop: spacing.sm },
});
