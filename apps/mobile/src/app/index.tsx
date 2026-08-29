// Sign-in + server picker. Adapted from the voice-ios-app branch (PR #1605)
// apps/mobile/src/app/index.tsx; divergences: chat-first copy, preview-slot
// presets + persisted recent custom servers, and the boot path — with valid
// stored auth this screen immediately forwards to the remembered project's
// chat list (the whole point of the app is cold-open → typing in seconds).

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Redirect, router, Stack } from "expo-router";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppDrawerButton } from "../components/project-drawer.tsx";
import { bundleRecommendation } from "../lib/expected-backend.ts";
import { getItxSession } from "../lib/itx.ts";
import { backfillProjectIfMissing, rememberedProjectInScope } from "../lib/open-project.ts";
import { DEFAULT_SERVER, PRODUCTION_PRESET } from "../lib/servers.ts";
import { useSession, useSignIn } from "../lib/session.ts";
import { clearLastProject, getLastProject } from "../lib/storage.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

export default function SignInScreen() {
  // The running bundle's expectation (lib/expected-backend.ts): a PR bundle
  // names its leased preview slot and per-PR test identity, a main/local
  // bundle names nothing. Suggestions only — they preselect the server and
  // ride the sign-in as a login_hint; the user still confirms everything.
  const expectation = bundleRecommendation();
  const recommended = expectation.server;
  const hintedEmail = expectation.email;
  // The app-global session decides whether to skip this screen; this query
  // only resolves WHERE a signed-in boot should land.
  const session = useSession();
  const bootstrap = useQuery({
    queryKey: ["bootstrap", session.data?.serverBaseUrl, session.data?.signedIn],
    enabled: session.isSuccess,
    queryFn: async () => {
      const server = session.data!.serverBaseUrl;
      const signedIn = session.data!.signedIn;
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
      return { lastProject };
    },
    staleTime: 0,
  });

  const [editedServer, setEditedServer] = useState<string | null>(null);
  // A recommended backend from a preview deep link preselects the server —
  // the user's own edits always win.
  const server =
    editedServer || recommended?.baseUrl || session.data?.serverBaseUrl || DEFAULT_SERVER;

  const signIn = useSignIn();
  const login = useMutation({
    mutationFn: async () => {
      const baseUrl = normalizeBaseUrl(server);
      // The test-identity hint only accompanies its own backend: signing in
      // anywhere else (say prd, where the test OTP is off) must not suggest a
      // mailbox nobody can read.
      const loginHint =
        hintedEmail !== null && recommended !== null && baseUrl === recommended.baseUrl
          ? hintedEmail
          : null;
      return signIn.mutateAsync({ baseUrl, loginHint });
    },
    onSuccess: () => {
      setEditedServer(null);
      // autoOpen: fresh sign-ins skip the picker when the account has exactly
      // one project (projects.tsx) — the first list can ride a cold itx
      // WebSocket, so the decision lives in the picker's retrying query, not
      // here. Plain /projects visits (Back from a project) never auto-open.
      router.replace({ pathname: "/projects", params: { autoOpen: "1" } });
    },
  });

  if (session.isPending || bootstrap.isPending) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} />
      </View>
    );
  }
  // Signed-in boots always fast-forward. The bundle's expectation never
  // interrupts here — the QR confirm screen (preview-channel/[channel].tsx)
  // is the one surface that offers the backend/identity switch, and this
  // screen only SUGGESTS (preselected server + login_hint) when you land on
  // it signed out anyway.
  if (session.data?.signedIn && editedServer === null) {
    const last = bootstrap.data?.lastProject;
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

  // Just two one-tap options at most: Production, plus the bundle's expected
  // backend when it names a preview slot. Twenty preview chips helped nobody
  // — anything else gets typed into the field.
  const serverOptions = [
    PRODUCTION_PRESET,
    ...(recommended !== null && recommended.baseUrl !== PRODUCTION_PRESET.baseUrl
      ? [recommended]
      : []),
  ];

  return (
    <SafeAreaView style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Build info must stay reachable while signed out / picking a backend —
          it names the running channel and commit, the first diagnostic when a
          preview looks wrong. */}
      <View style={styles.menuRow}>
        <AppDrawerButton />
      </View>
      <View style={styles.hero}>
        <Text style={styles.title}>Iterate</Text>
        <Text style={styles.subtitle}>
          Chat with your project&apos;s agents. Pick a deployment, sign in, start talking.
        </Text>
        {recommended !== null ? (
          <View style={styles.recommendation}>
            <Text style={styles.recommendationTitle}>Expected backend for this build</Text>
            <Text style={styles.recommendationBody}>
              {recommended.label}
              {hintedEmail !== null ? ` · test sign-in as ${hintedEmail}` : ""}
            </Text>
          </View>
        ) : null}
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
  menuRow: { alignItems: "flex-start" },
  hero: { flex: 1, justifyContent: "center", gap: spacing.md },
  recommendation: {
    backgroundColor: colors.surface,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
  },
  recommendationTitle: { color: colors.text, fontSize: 13, fontWeight: "600" },
  recommendationBody: { color: colors.textMuted, fontSize: 13 },
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
