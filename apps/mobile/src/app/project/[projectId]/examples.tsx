// Run a catalogue example against this project, from the phone. The same
// examples the web REPL's Examples panel shows (apps/os/src/itx/examples.ts),
// executed via capabilityHost.runScript directly — no local JS eval, and no
// wrapper beyond the one-line envelope every server-side runtime already
// uses (see apps/os/e2e/test-support/run-example.ts's runScriptEnvelope,
// which this mirrors — not worth sharing a whole module for). Exists so
// testing a platform feature (seeding an egress hold rule, appending to a
// stream, ...) never needs a laptop CLI step first: every mobile feature
// here is built by agents, so it needs to be fully testable from the phone
// alone.

import { useMutation, useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { phoneRunnableExamples } from "../../../lib/examples.ts";
import { getProjectItx } from "../../../lib/itx.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

const EXAMPLES = phoneRunnableExamples();

export default function ExamplesScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();

  const server = useQuery({
    queryKey: ["server"],
    queryFn: async () => (await getServerBaseUrl()) || DEFAULT_SERVER,
    staleTime: Infinity,
  });
  const baseUrl = server.data;

  const run = useMutation({
    mutationFn: async (exampleId: string) => {
      const example = EXAMPLES.find((candidate) => candidate.id === exampleId)!;
      const project = await getProjectItx(baseUrl!, projectId);
      const execution = await project.capabilityHost.runScript(
        `async (itx) => {\nconst vars = {};\n${example.code}\n}`,
      );
      return execution.result;
    },
  });

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Examples" }} />
      <FlatList
        data={EXAMPLES}
        keyExtractor={(example) => example.id}
        contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
        renderItem={({ item: example }) => {
          const pending = run.isPending && run.variables === example.id;
          const ran = run.variables === example.id;
          return (
            <View style={styles.card}>
              <Text style={styles.title}>{example.title}</Text>
              <Text style={styles.description}>{example.description}</Text>
              <Pressable
                style={[styles.button, pending && styles.buttonDisabled]}
                disabled={pending || !baseUrl}
                onPress={() => run.mutate(example.id)}
              >
                <Text style={styles.buttonText}>{pending ? "Running…" : "Run"}</Text>
              </Pressable>
              {ran && run.isSuccess ? (
                <Text style={styles.result} selectable>
                  {JSON.stringify(run.data, null, 2)}
                </Text>
              ) : null}
              {ran && run.isError ? (
                <Text style={styles.error} selectable>
                  {String(run.error.message)}
                </Text>
              ) : null}
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  title: { color: colors.text, fontSize: 15, fontWeight: "600" },
  description: { color: colors.textMuted, fontSize: 12 },
  button: {
    alignSelf: "flex-start",
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: colors.background, fontSize: 13, fontWeight: "600" },
  result: {
    color: colors.text,
    fontFamily: "Menlo",
    fontSize: 11,
    marginTop: spacing.xs,
  },
  error: { color: colors.danger, fontFamily: "Menlo", fontSize: 11, marginTop: spacing.xs },
});
