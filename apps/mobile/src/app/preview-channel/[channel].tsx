// Deep-link target for PR preview QRs:
//   iterate://preview-channel/<channel>[?env=<envs.ts key>&email=<*+test@nustom.com>]
// `env` is the PR's leased preview slot — the backend this channel's JS
// expects — and `email` a per-PR test identity (CI bakes both in,
// scripts/ci/publish-mobile-pr-preview.ts). This screen owns TWO decisions
// and one non-decision:
// - The channel switch stays a confirm, not an auto-switch: a stray link tap
//   shouldn't silently repoint the app at another PR's JS.
// - Freshness is automatic: once the channel already matches, the scan itself
//   is the intent ("run what this QR shows"), so the screen pulls the
//   channel's latest update and reloads into it. (Switching also fetches
//   latest — switchChannelAndReload's check/fetch/reload.)
// - Backend/identity differences from the QR's recommendation are SHOWN, with
//   a one-tap fix, never applied silently. `env` resolves against the preset
//   list only (serverPresetForEnvKey), so a crafted link can't name an
//   arbitrary server; the hints also still ferry to the sign-in screen via
//   Continue.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Updates from "expo-updates";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { getSignedInEmail, signIn } from "../../lib/auth.ts";
import { buildInfo } from "../../lib/build-info.ts";
import {
  recommendationMismatches,
  recommendationSwitchPlan,
  testEmailFromHint,
  type SwitchPlan,
} from "../../lib/deep-link-hints.ts";
import { reconnectItxSession } from "../../lib/itx.ts";
import {
  fetchLatestUpdateAndReload,
  getPreviewChannelOverride,
  switchChannelAndReload,
} from "../../lib/preview-channel.ts";
import { DEFAULT_SERVER, serverPresetForEnvKey } from "../../lib/servers.ts";
import { getServerBaseUrl, setServerBaseUrl } from "../../lib/storage.ts";
import { colors, radius, spacing } from "../../lib/theme.ts";

export default function PreviewChannelScreen() {
  const params = useLocalSearchParams<{ channel: string; env?: string; email?: string }>();
  const { channel } = params;
  const router = useRouter();
  const queryClient = useQueryClient();
  const current = useQuery({
    queryKey: ["preview-channel-override"],
    queryFn: getPreviewChannelOverride,
  });

  const recommendedServer =
    typeof params.env === "string" ? serverPresetForEnvKey(params.env) : null;
  // The test-identity hint ferries onward for per-PR test addresses only;
  // anything else in the param is dropped rather than suggested.
  const testEmail = testEmailFromHint(params.email);
  // What the sign-in screen receives on Continue. Hints only — nothing here
  // changes state; the sign-in screen suggests, the user decides.
  const hintParams = {
    ...(recommendedServer !== null && typeof params.env === "string" ? { env: params.env } : {}),
    ...(testEmail !== null ? { email: testEmail } : {}),
  };

  const switchChannel = useMutation({
    mutationFn: () => switchChannelAndReload(channel),
    // Only reaches onSuccess without a reload ("no-update"); the invalidate
    // flips `current` and the button below becomes "Continue". After a real
    // reload the deep link re-opens this screen in the NEW bundle.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["preview-channel-override"] }),
  });

  // Already on the target channel — including the relaunch after a successful
  // switch, where the deep link URL re-opens this screen. Deliberately NOT a
  // silent redirect: scanning a QR for the channel you're already on should
  // SHOW you that (Current = Target, plus the running commit) rather than
  // leave you wondering whether anything happened. Continue hands the hints
  // to the sign-in screen.
  const alreadyOnTarget = current.isSuccess && current.data === channel;

  // Dev bundles (Metro native OR expo web dev, where isEnabled is true but
  // checkForUpdateAsync throws "cannot check for updates in development
  // mode") can't OTA.
  const canOta = Updates.isEnabled && !__DEV__;

  // Scanning always means "the latest": once the channel matches, pull its
  // newest update and reload into it, visibly. A query rather than an effect
  // — run-on-mount work is what queries are for here — and "per scan" means
  // per MOUNT (refetchOnMount "always"), not per process: the queryClient
  // outlives this screen, and a rescan after CI publishes again must check
  // again, not reuse a cached "up-to-date". Post-reload re-entry runs it
  // once more, finds the now-running update is the latest, and stops: no
  // loop.
  const freshness = useQuery({
    queryKey: ["qr-channel-freshness", channel],
    enabled: alreadyOnTarget && canOta,
    queryFn: fetchLatestUpdateAndReload,
    staleTime: Infinity,
    refetchOnMount: "always",
    retry: false,
  });
  // While this is true a reloadAsync may fire at any moment — nothing that
  // opens a flow the reload would sever (OAuth, most of all) may start.
  const reloadImminent = freshness.isFetching || freshness.data === "reloading";

  // Where the phone actually points and who it's signed in as — compared
  // against the QR's recommendation below. The identity read may cost one
  // token refresh; fine for a scan flow. Only once the channel matches: the
  // mismatch card renders post-switch only (see below), and pre-switch the
  // imminent reload would throw the read away.
  const phoneState = useQuery({
    queryKey: ["qr-phone-state", recommendedServer?.baseUrl || null],
    enabled: alreadyOnTarget && recommendedServer !== null,
    queryFn: async () => {
      const serverBaseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const email = await getSignedInEmail(serverBaseUrl);
      const recommendedServerEmail =
        recommendedServer!.baseUrl === serverBaseUrl
          ? email
          : await getSignedInEmail(recommendedServer!.baseUrl);
      return { serverBaseUrl, email, recommendedServerEmail };
    },
  });
  const qr = { server: recommendedServer, email: testEmail };
  const mismatches = phoneState.data ? recommendationMismatches(phoneState.data, qr) : [];
  const plan = phoneState.data ? recommendationSwitchPlan(phoneState.data, qr) : null;

  const applyPlan = useMutation({
    mutationFn: async (input: SwitchPlan) => {
      await setServerBaseUrl(input.baseUrl);
      if (input.type === "sign-in") {
        await signIn(input.baseUrl, input.loginHint ? { loginHint: input.loginHint } : {});
      }
      return input.baseUrl;
    },
    // Mirrors the sign-in screen's login mutation: reconnect on the new
    // deployment, drop every cached read, land on the boot path (which
    // fast-forwards to the remembered project or the picker).
    onSuccess: (baseUrl) => {
      reconnectItxSession(baseUrl);
      queryClient.clear();
      router.replace("/");
    },
  });

  const currentChannel = current.data || Updates.channel || "preview";

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Switch preview channel" }} />
      <Text style={styles.heading}>
        {alreadyOnTarget ? "You're already on this channel" : "Point this app at another channel?"}
      </Text>
      <View style={styles.card}>
        <Row label="Current" value={currentChannel} />
        <Row label="Target" value={channel} />
        {recommendedServer !== null ? (
          <Row label="Recommended backend" value={recommendedServer.label} />
        ) : null}
        <Row
          label="Running"
          value={`${buildInfo.branch || "?"} @ ${buildInfo.commit.slice(0, 7) || "?"}`}
        />
        {buildInfo.message ? <Row label="Commit" value={buildInfo.message} /> : null}
      </View>
      {alreadyOnTarget ? (
        <>
          {canOta ? (
            <Text style={freshness.isError ? styles.errorNote : styles.note}>
              {freshness.isFetching
                ? "Checking this channel for its latest update…"
                : freshness.data === "reloading"
                  ? "Newer update found — fetching and restarting…"
                  : freshness.isError
                    ? String(freshness.error)
                    : "You're running this channel's latest update."}
            </Text>
          ) : (
            <Text style={styles.note}>
              OTA updates don't run in dev bundles — can't pull the channel's latest here.
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace({ pathname: "/", params: hintParams })}
            style={styles.button}
          >
            <Text style={styles.buttonLabel}>Continue</Text>
          </Pressable>
        </>
      ) : !Updates.isEnabled ? (
        <Text style={styles.note}>
          OTA updates are off in this bundle (Metro dev server) — channel switching only works in
          installed builds.
        </Text>
      ) : (
        <Pressable
          accessibilityRole="button"
          disabled={switchChannel.isPending}
          onPress={() => switchChannel.mutate()}
          style={[styles.button, switchChannel.isPending && styles.buttonDisabled]}
        >
          <Text style={styles.buttonLabel}>
            {switchChannel.isPending ? "Switching…" : `Switch to ${channel}`}
          </Text>
        </Pressable>
      )}
      {switchChannel.data === "no-update" ? (
        <Text style={styles.note}>
          Switched, but the channel has nothing this binary can run — either nothing is published
          yet, or the PR has native changes (install its build instead). The override sticks; the
          app will pick updates up once compatible ones are published.
        </Text>
      ) : null}
      {switchChannel.error ? (
        <Text style={styles.errorNote}>{String(switchChannel.error)}</Text>
      ) : null}
      {/* Backend/identity come AFTER the channel: pre-switch, the one action
          on screen is the channel switch — showing the plan button too would
          let a tap route away with the switch never made (running the old
          channel's JS against the new backend). The post-switch reload
          re-opens this deep link, and the card appears then. */}
      {alreadyOnTarget && recommendedServer !== null && mismatches.length > 0 ? (
        <>
          <Text style={styles.mismatchHeading}>This QR expects a different setup</Text>
          <View style={styles.card}>
            {mismatches.map((mismatch) =>
              mismatch.kind === "backend" ? (
                <Row
                  key="backend"
                  label="Backend"
                  value={`${mismatch.current.replace(/^https?:\/\//, "")} → ${mismatch.recommended.label}`}
                />
              ) : (
                <Row
                  key="identity"
                  label="Signed in"
                  value={`${mismatch.current || "not signed in"} → ${mismatch.recommended}`}
                />
              ),
            )}
          </View>
          {plan !== null ? (
            // Held while a freshness reload could fire mid-flow: reloadAsync
            // during the sign-in OAuth hop would sever it half way. The
            // reload re-opens this screen and the button unlocks then.
            <Pressable
              accessibilityRole="button"
              disabled={applyPlan.isPending || reloadImminent}
              onPress={() => applyPlan.mutate(plan)}
              style={[
                styles.button,
                (applyPlan.isPending || reloadImminent) && styles.buttonDisabled,
              ]}
            >
              <Text style={styles.buttonLabel}>
                {applyPlan.isPending
                  ? "Switching…"
                  : planLabel(plan, phoneState.data!.serverBaseUrl)}
              </Text>
            </Pressable>
          ) : null}
          {applyPlan.error ? <Text style={styles.errorNote}>{String(applyPlan.error)}</Text> : null}
        </>
      ) : alreadyOnTarget && recommendedServer !== null && phoneState.isSuccess ? (
        <Text style={styles.note}>Backend and sign-in match this QR's recommendation.</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        // Deep links open this screen with no back stack.
        onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        style={styles.linkButton}
      >
        <Text style={styles.linkLabel}>Cancel</Text>
      </Pressable>
    </View>
  );
}

function planLabel(plan: SwitchPlan, currentServerBaseUrl: string) {
  if (plan.type === "use-server") return `Use ${plan.label}`;
  const where = plan.baseUrl === currentServerBaseUrl ? "" : ` on ${plan.label}`;
  return plan.loginHint ? `Sign in${where} as ${plan.loginHint}` : `Sign in${where}`;
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text selectable style={styles.rowValue}>
        {value || "—"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.lg, padding: spacing.lg },
  heading: { color: colors.text, fontSize: 18, fontWeight: "600" },
  mismatchHeading: { color: colors.text, fontSize: 15, fontWeight: "600" },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
  },
  row: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
    paddingVertical: 12,
  },
  rowLabel: { color: colors.textMuted, fontSize: 14 },
  rowValue: {
    color: colors.text,
    flexShrink: 1,
    fontSize: 14,
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
  button: {
    alignItems: "center",
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonLabel: { color: colors.text, fontSize: 16, fontWeight: "600", textAlign: "center" },
  linkButton: { alignItems: "center", paddingVertical: 8 },
  linkLabel: { color: colors.textMuted, fontSize: 14 },
  note: { color: colors.textMuted, fontSize: 13, textAlign: "center" },
  errorNote: { color: colors.danger, fontSize: 13, textAlign: "center" },
});
