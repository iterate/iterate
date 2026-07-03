import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Redirect, Stack } from "expo-router";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { hasSignIn, signIn } from "../lib/auth.ts";
import { DEFAULT_SERVER, SERVER_PRESETS } from "../lib/servers.ts";
import { getServerBaseUrl, setServerBaseUrl } from "../lib/storage.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

export default function SignInScreen() {
  const queryClient = useQueryClient();
  // Persisted server + sign-in state decide whether to skip this screen.
  const bootstrap = useQuery({
    queryKey: ["bootstrap"],
    queryFn: async () => {
      const server = (await getServerBaseUrl()) || DEFAULT_SERVER;
      return { server, signedIn: await hasSignIn(server) };
    },
    staleTime: 0,
  });

  const [editedServer, setEditedServer] = useState<string | null>(null);
  const server = editedServer ?? bootstrap.data?.server ?? DEFAULT_SERVER;

  const login = useMutation({
    mutationFn: async () => {
      const baseUrl = normalizeBaseUrl(server);
      await setServerBaseUrl(baseUrl);
      await signIn(baseUrl);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
  });

  if (bootstrap.isPending) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }
  if (bootstrap.data?.signedIn && editedServer === null) {
    return <Redirect href="/projects" />;
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.hero}>
        <Text style={styles.title}>Iterate Voice</Text>
        <Text style={styles.subtitle}>
          Talk to your project. A worker agent does the work; a voice assistant keeps you company.
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
          {SERVER_PRESETS.map((preset) => (
            <Pressable
              key={preset.baseUrl}
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
          onPress={() => login.mutate()}
          disabled={login.isPending}
          style={[styles.signIn, login.isPending && { opacity: 0.6 }]}
        >
          {login.isPending ? (
            <ActivityIndicator color={colors.background} />
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
