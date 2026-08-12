// Deep-link target for PR preview QRs: iterate://preview-channel/<channel>.
// The channel is ALL the link carries — the expected backend + test identity
// are stamped into the published bundle itself (lib/expected-backend.ts), so
// after the switch-reload the NEW bundle self-describes. This screen owns TWO
// decisions and one non-decision:
// - The channel switch stays a confirm, not an auto-switch: a stray link tap
//   shouldn't silently repoint the app at another PR's JS.
// - Freshness is automatic: once the channel already matches, the scan itself
//   is the intent ("run what this QR shows"), so the screen pulls the
//   channel's latest update and reloads into it. (Switching also fetches
//   latest — switchChannelAndReload's check/fetch/reload.)
// - Backend/identity differences from the running bundle's expectation are
//   SHOWN, and the fix rides Continue as a default-checked checkbox — wanting
//   the PR's JS almost always means wanting its backend + test identity too,
//   but unticking keeps the plain channel switch. Never applied from a bare
//   scan — but a Switch TAP consents to the whole plan, so the post-switch
//   re-entry continues by itself (the one-shot marker in
//   lib/preview-channel.ts) instead of asking for a second tap.
//   The stamp resolves against the preset list only (lib/expected-backend.ts),
//   so a poisoned bundle stamp can't name an arbitrary server.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Updates from "expo-updates";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { getSignedInEmail, signIn } from "../../lib/auth.ts";
import { buildInfo } from "../../lib/build-info.ts";
import {
  bundleRecommendation,
  recommendationMismatches,
  recommendationSwitchPlan,
  type SwitchPlan,
} from "../../lib/expected-backend.ts";
import { reconnectItxSession } from "../../lib/itx.ts";
import {
  clearAutoContinueChannel,
  fetchLatestUpdateAndReload,
  getAutoContinueChannel,
  getPreviewChannelOverride,
  setAutoContinueChannel,
  switchChannelAndReload,
} from "../../lib/preview-channel.ts";
import { DEFAULT_SERVER } from "../../lib/servers.ts";
import { getServerBaseUrl, setServerBaseUrl } from "../../lib/storage.ts";
import { colors, radius, spacing } from "../../lib/theme.ts";

export default function PreviewChannelScreen() {
  const params = useLocalSearchParams<{ channel: string }>();
  const { channel } = params;
  const router = useRouter();
  const queryClient = useQueryClient();
  const current = useQuery({
    queryKey: ["preview-channel-override"],
    queryFn: getPreviewChannelOverride,
  });

  // The RUNNING bundle's expectation. Pre-switch this describes the old
  // bundle, so nothing below uses it until the channel matches — the
  // switch-reload re-opens this screen in the target bundle, and only then
  // is the recommendation the one the QR's channel implies.
  const expectation = bundleRecommendation();
  const recommendedServer = expectation.server;

  const switchChannel = useMutation({
    mutationFn: async () => {
      // The Switch tap IS the consent for the whole plan (channel + backend +
      // test identity): mark it before the reload wipes this process, so the
      // re-opened screen continues without a second tap.
      await setAutoContinueChannel(channel);
      return switchChannelAndReload(channel);
    },
    // Only reaches onSuccess without a reload ("no-update"); the invalidate
    // flips `current` and the button below becomes "Continue". After a real
    // reload the deep link re-opens this screen in the NEW bundle.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["preview-channel-override"] }),
  });

  // Already on the target channel — including the relaunch after a successful
  // switch, where the deep link URL re-opens this screen. Deliberately NOT a
  // silent redirect: scanning a QR for the channel you're already on should
  // SHOW you that (Current = Target, plus the running commit) rather than
  // leave you wondering whether anything happened.
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
  // against the bundle's expectation below. The identity read may cost one
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
  const mismatches = phoneState.data ? recommendationMismatches(phoneState.data, expectation) : [];
  const plan = phoneState.data ? recommendationSwitchPlan(phoneState.data, expectation) : null;

  const applyPlan = useMutation({
    mutationFn: async (input: SwitchPlan) => {
      await setServerBaseUrl(input.baseUrl);
      if (input.type === "sign-in") {
        await signIn(input.baseUrl, input.loginHint ? { loginHint: input.loginHint } : {});
      }
      return input.baseUrl;
    },
    // Mirrors the sign-in screen's login mutation: reconnect on the new
    // deployment, drop every cached read, and land where it does — fresh
    // sign-ins go to the picker with autoOpen so a single-project account
    // (every per-PR test identity) skips it; a plain server switch takes the
    // boot path (remembered project or picker).
    onSuccess: (baseUrl, input) => {
      reconnectItxSession(baseUrl);
      queryClient.clear();
      if (input.type === "sign-in") {
        router.replace({ pathname: "/projects", params: { autoOpen: "1" } });
      } else {
        router.replace("/");
      }
    },
  });

  // The post-switch auto-continue: once the switch-reload has re-opened this
  // screen and everything has settled (freshness verdict in, phone state
  // read), do exactly what the Continue button would — but only when the
  // one-shot marker from the Switch tap is present. Fresh scans of a channel
  // the app is already on have no marker and keep the reassurance screen.
  // A query rather than an effect, like the freshness check above.
  useQuery({
    queryKey: ["qr-channel-auto-continue", channel],
    enabled:
      alreadyOnTarget &&
      !reloadImminent &&
      (!canOta || freshness.isSuccess || freshness.isError) &&
      (recommendedServer === null || phoneState.isSuccess || phoneState.isError),
    staleTime: Infinity,
    refetchOnMount: "always",
    retry: false,
    queryFn: async () => {
      const pending = await getAutoContinueChannel();
      if (pending !== channel) {
        return "none" as const;
      }
      await clearAutoContinueChannel();
      if (plan !== null) {
        await applyPlan.mutateAsync(plan);
      } else {
        router.replace("/");
      }
      return "continued" as const;
    },
  });

  // Whether Continue also applies the switch plan. Default-checked: the
  // whole point of scanning a PR QR is running its JS against its backend.
  const [applyPlanOnContinue, setApplyPlanOnContinue] = useState(true);

  const currentChannel = current.data || Updates.channel || "preview";

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Switch preview channel" }} />
      {/* One screen, two states: "switch?" before, "you're on it" after the
          switch-reload re-opens this deep link in the target bundle. The
          post-switch state is deliberately not a redirect — it confirms the
          switch landed and owns the freshness check + setup fix below. */}
      <Text style={styles.heading}>
        {alreadyOnTarget ? "You're on this channel" : "Point this app at another channel?"}
      </Text>
      <View style={styles.card}>
        <Row label="Current" value={currentChannel} />
        <Row label="Target" value={channel} />
        {/* Only once the channel matches: pre-switch, the running (old)
            bundle's expectation says nothing about the target channel. */}
        {alreadyOnTarget && recommendedServer !== null ? (
          <Row label="Expected backend" value={recommendedServer.label} />
        ) : null}
        <Row
          label="Running"
          value={`${buildInfo.branch || "?"} @ ${buildInfo.commit.slice(0, 7) || "?"}`}
        />
        {buildInfo.message ? <Row label="Commit" value={buildInfo.message} /> : null}
      </View>
      {alreadyOnTarget ? (
        canOta ? (
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
        )
      ) : !Updates.isEnabled ? (
        <Text style={styles.note}>
          OTA updates are off in this bundle (Metro dev server) — channel switching only works in
          installed builds.
        </Text>
      ) : (
        <>
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
          {/* Pre-switch, the running (old) bundle can't know the target's
              backend — set the expectation that the offer comes after. */}
          <Text style={styles.note}>
            After the switch this screen reloads into the new bundle and offers its expected backend
            and test sign-in, if it names them.
          </Text>
        </>
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
          <Text style={styles.mismatchHeading}>This bundle expects a different setup</Text>
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
            // The fix rides Continue below rather than being its own button —
            // "run this PR's JS" and "against its backend, as its identity"
            // are one intent, so both happen on one tap unless unticked.
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: applyPlanOnContinue }}
              // RN-web doesn't project accessibilityState.checked onto the DOM.
              aria-checked={applyPlanOnContinue}
              onPress={() => setApplyPlanOnContinue(!applyPlanOnContinue)}
              style={styles.checkboxRow}
            >
              <View style={[styles.checkbox, applyPlanOnContinue && styles.checkboxChecked]}>
                {applyPlanOnContinue ? <Text style={styles.checkboxMark}>✓</Text> : null}
              </View>
              <Text style={styles.checkboxLabel}>
                {planLabel(plan, phoneState.data!.serverBaseUrl)}
              </Text>
            </Pressable>
          ) : null}
          {applyPlan.error ? <Text style={styles.errorNote}>{String(applyPlan.error)}</Text> : null}
        </>
      ) : alreadyOnTarget && recommendedServer !== null && phoneState.isSuccess ? (
        <Text style={styles.note}>Backend and sign-in match what this bundle expects.</Text>
      ) : null}
      {alreadyOnTarget ? (
        // Held while a freshness reload could fire mid-flow: reloadAsync
        // during the sign-in OAuth hop would sever it half way. The reload
        // re-opens this screen and the button unlocks then. (Only blocking
        // when Continue would actually start that flow.)
        <Pressable
          accessibilityRole="button"
          disabled={applyPlan.isPending || (reloadImminent && plan !== null && applyPlanOnContinue)}
          onPress={() =>
            plan !== null && applyPlanOnContinue ? applyPlan.mutate(plan) : router.replace("/")
          }
          style={[
            styles.button,
            (applyPlan.isPending || (reloadImminent && plan !== null && applyPlanOnContinue)) &&
              styles.buttonDisabled,
          ]}
        >
          <Text style={styles.buttonLabel}>{applyPlan.isPending ? "Switching…" : "Continue"}</Text>
        </Pressable>
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
  checkboxRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingVertical: 4,
  },
  checkbox: {
    alignItems: "center",
    borderColor: colors.textFaint,
    borderRadius: 4,
    borderWidth: 1.5,
    height: 22,
    justifyContent: "center",
    width: 22,
  },
  checkboxChecked: { backgroundColor: colors.surfaceRaised, borderColor: colors.text },
  checkboxMark: { color: colors.text, fontSize: 14, fontWeight: "700", lineHeight: 16 },
  checkboxLabel: { color: colors.text, flexShrink: 1, fontSize: 14 },
  linkButton: { alignItems: "center", paddingVertical: 8 },
  linkLabel: { color: colors.textMuted, fontSize: 14 },
  note: { color: colors.textMuted, fontSize: 13, textAlign: "center" },
  errorNote: { color: colors.danger, fontSize: 13, textAlign: "center" },
});
