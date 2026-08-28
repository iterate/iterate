// Providing a secret, natively, without leaving the thread.
//
// An agent that needs a credential it must never see sends a
// `/collect-secret/...` link into the chat (minted by
// `itx.secrets.collectFromUser`). On the web that link opens a chrome-free
// page. On the phone we do not open anything: the app already holds an
// authenticated itx session, so it renders the same request as a sheet and
// writes the secret over the connection it has. No browser, no second
// sign-in, no consent prompt, no app switch — and one hop fewer than the web
// path, since the material goes app → itx → Secret DO.
//
// Everything the page promises, this promises: the value is stored write-only
// and pinned to the listed origins in one update, and the agent that asked is
// told it is ready. The agent never sees the value on either path.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { parseCollectSecretLink } from "../../../lib/collect-secret-link.ts";
import { getProjectItx } from "../../../lib/itx.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

export default function CollectSecretScreen() {
  const { link, projectId } = useLocalSearchParams<{ link: string; projectId: string }>();
  const request = parseCollectSecretLink(link || "");
  return (
    <>
      <Stack.Screen options={{ title: "Provide a secret" }} />
      {request === null ? (
        <MalformedLink />
      ) : (
        <CollectSecretForm projectId={projectId} request={request} />
      )}
    </>
  );
}

function MalformedLink() {
  return (
    <View style={styles.centered}>
      <Text style={styles.title}>This link is malformed</Text>
      <Text style={styles.muted}>
        It does not describe a usable secret. Ask whoever sent it for a fresh link.
      </Text>
    </View>
  );
}

/** How the submit ended: stored + agent told, stored but the notify failed
 * (the one partial state — the user must relay by hand), or stored with no
 * agent to tell. The secret itself is never half-stored: material and egress
 * land in one update. */
type SavedOutcome = "notified" | "notify-failed" | "no-notify";

function CollectSecretForm({
  projectId,
  request,
}: {
  projectId: string;
  request: NonNullable<ReturnType<typeof parseCollectSecretLink>>;
}) {
  const [material, setMaterial] = useState("");
  const [revealed, setRevealed] = useState(false);
  const queryClient = useQueryClient();
  const server = useQuery({
    queryKey: ["server"],
    queryFn: async () => (await getServerBaseUrl()) || DEFAULT_SERVER,
    staleTime: Infinity,
  });
  const baseUrl = server.data;

  // The link can point at an EXISTING secret — submitting would replace its
  // material and repin its egress. Say so before anything is typed.
  const existing = useQuery({
    queryKey: ["collect-secret", baseUrl || "", projectId, request.path],
    queryFn: async () => {
      // Narrowed rather than asserted: `enabled` already keeps this from
      // running before the stored server URL is read, so the branch is
      // unreachable — but a real check keeps it that way if `enabled` changes.
      if (baseUrl === undefined) throw new Error("No server selected.");
      const project = await getProjectItx(baseUrl, projectId);
      return await project.secrets.get(request.path).__describe();
    },
    enabled: baseUrl !== undefined,
    // A stored secret is exactly what this screen changes, so the default
    // 15s staleness window is wrong here: reopening the same link after
    // saving must ask again, or the "this replaces an existing secret"
    // warning would be missing on the visit where it matters most. That is
    // about remounting, though — NOT about focus. Leaving the app to fetch
    // the credential from a password manager is the main way this screen is
    // used, and coming back is no reason to re-ask.
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  const submit = useMutation({
    mutationFn: async (value: string): Promise<SavedOutcome> => {
      // Nothing guarded this before: the form renders while the stored server
      // URL is still being read, so a fast paste-and-save could reach here
      // with none. Save now waits for it (below), and this is the check that
      // says so rather than an assertion hoping it holds.
      if (baseUrl === undefined) throw new Error("No server selected.");
      const project = await getProjectItx(baseUrl, projectId);
      const secret = project.secrets.get(request.path);
      // Material and egress land in one birth or update, so the secret is
      // pinned to its hosts — no window where it exists but cannot be used.
      const input = { material: value, egress: { urls: request.egress } };
      // Which verb to use is decided HERE, from a fresh read — never from the
      // query above. create() over an existing secret with the same policy is
      // a deliberate no-op that KEEPS the old material (rotation is update()'s
      // job), and the stored-material check below cannot tell the difference,
      // because the old material is material. So a stale "does it exist?"
      // answer would silently drop the value the user just typed and still
      // report success to them and to the agent.
      if ((await secret.__describe()).created) await secret.update(input);
      else await secret.create(input);
      // describe() is read-your-writes, so one assertion is the honest
      // "stored and usable" check before anything is announced.
      if ((await secret.__describe()).hasMaterial !== true) {
        throw new Error(`The secret at ${request.path} did not report stored material.`);
      }
      if (request.notify === undefined) return "no-notify";
      // The secret IS stored from here on — a notify failure must not present
      // as total failure (the user would retype; the agent would wait forever).
      try {
        await project.agents
          .get(request.notify)
          .message(
            `I submitted the secret at "${request.path}" via your collection link. ` +
              `It is stored write-only, pinned to ${request.egress.join(", ")}, and ready ` +
              `to use with getSecret placeholders.`,
          );
        return "notified";
      } catch (error) {
        console.error(`collect-secret: failed to notify ${request.notify}`, error);
        return "notify-failed";
      }
    },
    // What we just wrote is what the existence query answers, so its cached
    // answer is now wrong.
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["collect-secret", baseUrl || "", projectId, request.path],
      }),
  });

  if (submit.data !== undefined) return <Saved outcome={submit.data} path={request.path} />;

  // No submitting before there is somewhere to submit to, before we know
  // whether this replaces an existing secret (the warning above is a promise
  // — it has to be on screen before you can commit), or twice.
  //
  // Gated on HAVING an answer, not on the query's current status: a
  // background refetch that fails leaves the answer we already have in place,
  // and must not take the button away from someone who has just come back
  // with a credential in their clipboard.
  const checked = !!existing.data;
  const canSave = material.length > 0 && baseUrl !== undefined && checked && !submit.isPending;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.flex}
    >
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.muted}>
          Someone in {request.projectSlug} asked for a credential only you have.
        </Text>
        {request.description === undefined ? null : (
          <Text style={styles.description}>{request.description}</Text>
        )}
        <View style={styles.facts}>
          <Text style={styles.factLabel}>Stored at</Text>
          <Text style={styles.factValue} numberOfLines={1}>
            {request.path}
          </Text>
          <Text style={styles.factLabel}>Only ever sent to</Text>
          <Text style={styles.factValue}>{request.egress.join(", ")}</Text>
        </View>

        {existing.data?.hasMaterial === true ? (
          <View style={styles.warning}>
            <Text style={styles.warningTitle}>This replaces an existing secret</Text>
            <Text style={styles.warningBody}>
              Saving overwrites the value at {request.path} and its allowed hosts
              {existing.data.egress.urls.length > 0
                ? ` (currently ${existing.data.egress.urls.join(", ")})`
                : ""}
              .
            </Text>
          </View>
        ) : null}

        <Text style={styles.fieldLabel}>Value</Text>
        <View style={styles.inputRow}>
          <TextInput
            accessibilityLabel="Value"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setMaterial}
            placeholder="Paste the credential"
            placeholderTextColor={colors.textFaint}
            secureTextEntry={!revealed}
            spellCheck={false}
            style={styles.input}
            value={material}
          />
          {/* Pasting a credential on a phone is a blind action — this is how
              you check you pasted the key and not your shopping list. */}
          <Pressable
            accessibilityLabel={revealed ? "Hide value" : "Show value"}
            onPress={() => setRevealed(!revealed)}
            style={styles.reveal}
          >
            <Text style={styles.revealText}>{revealed ? "🙈" : "👁"}</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>
          Stored write-only and encrypted — only ever substituted into requests to the hosts above,
          never readable by an agent, an API, or a person.
        </Text>

        {checked || !existing.isError ? null : (
          <View style={styles.warning}>
            <Text style={styles.warningTitle}>Could not check this secret</Text>
            <Text style={styles.warningBody}>
              We could not tell whether {request.path} already exists, so saving is held until we
              can — a value entered now might replace one you cannot see.
            </Text>
            <Pressable
              accessibilityLabel="Try again"
              onPress={() => void existing.refetch()}
              style={styles.retry}
            >
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        )}
        {!submit.isPending ? null : (
          // A page-level busy row, not just a button that changed label:
          // storing a secret is several round trips, and the person who just
          // pasted a credential should be told what is happening to it. The
          // "Loading" label is also what middlewright's spinner-waiter looks
          // for — the button's own indicator was not being credited.
          <View accessibilityLabel="Loading" style={styles.savingNotice}>
            <ActivityIndicator color={colors.textMuted} size="small" />
            <Text style={styles.hint}>Storing the secret…</Text>
          </View>
        )}
        {submit.error === null ? null : (
          <Text data-type="error" style={styles.error}>
            {submit.error instanceof Error ? submit.error.message : String(submit.error)}
          </Text>
        )}

        <Pressable
          accessibilityLabel="Save secret"
          disabled={!canSave}
          onPress={() => submit.mutate(material)}
          style={[styles.save, !canSave && styles.saveDisabled]}
        >
          {submit.isPending || !checked ? (
            <View style={styles.savingRow}>
              <ActivityIndicator
                accessibilityLabel="Loading"
                color={colors.background}
                size="small"
              />
              <Text style={styles.saveText}>{submit.isPending ? "Saving…" : "Checking…"}</Text>
            </View>
          ) : (
            <Text style={styles.saveText}>Save secret</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Saved({ outcome, path }: { outcome: SavedOutcome; path: string }) {
  return (
    <View style={styles.centered}>
      <Text style={styles.title}>Secret saved</Text>
      <Text style={styles.muted}>
        {outcome === "notified"
          ? "The agent that asked for it has been notified and will pick up from here."
          : outcome === "notify-failed"
            ? `The secret is stored, but the agent that asked could not be notified. Tell it the secret at ${path} is ready.`
            : "It is stored and ready to use."}
      </Text>
      <Pressable
        accessibilityLabel="Back to chat"
        onPress={() => router.back()}
        style={styles.save}
      >
        <Text style={styles.saveText}>Back to chat</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { gap: spacing.md, padding: spacing.md },
  centered: { flex: 1, gap: spacing.md, justifyContent: "center", padding: spacing.lg },
  title: { color: colors.text, fontSize: 18, fontWeight: "600" },
  muted: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  description: { color: colors.text, fontSize: 14, lineHeight: 20 },
  facts: { gap: 2 },
  factLabel: { color: colors.textMuted, fontSize: 11 },
  factValue: { color: colors.text, fontFamily: "Menlo", fontSize: 12, marginBottom: 6 },
  warning: {
    backgroundColor: colors.surface,
    borderColor: colors.danger,
    borderRadius: radius.sm,
    borderWidth: 1,
    gap: 4,
    padding: spacing.sm,
  },
  warningTitle: { color: colors.danger, fontSize: 13, fontWeight: "600" },
  retry: {
    alignSelf: "flex-start",
    borderColor: colors.border,
    borderRadius: radius.full,
    borderWidth: 1,
    marginTop: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  retryText: { color: colors.text, fontSize: 13 },
  warningBody: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  fieldLabel: { color: colors.text, fontSize: 13, fontWeight: "600" },
  inputRow: { alignItems: "center", flexDirection: "row", gap: spacing.sm },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    color: colors.text,
    flex: 1,
    fontSize: 15,
    paddingHorizontal: spacing.sm,
    paddingVertical: 10,
  },
  reveal: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  revealText: { fontSize: 16 },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  error: { color: colors.danger, fontSize: 13 },
  save: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    paddingVertical: 12,
  },
  saveDisabled: { opacity: 0.5 },
  savingRow: { alignItems: "center", flexDirection: "row", gap: spacing.sm },
  savingNotice: { alignItems: "center", flexDirection: "row", gap: spacing.sm, minHeight: 20 },
  saveText: { color: colors.background, fontSize: 15, fontWeight: "600" },
});
