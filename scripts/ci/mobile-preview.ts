// Shared machinery for the mobile preview QR sections that CI maintains on
// PR bodies (scripts/ci/publish-mobile-pr-preview.ts) and main commit
// comments (scripts/ci/publish-mobile-update.ts): eas-cli JSON calls,
// find-or-trigger install builds, QR generation/upload, and the rendered
// two-QR markdown section.
//
// Links deliberately go through the OS https interstitial
// (`/m/preview-channel/<channel>`, apps/os/src/routes/m.preview-channel.$channel.ts)
// rather than `iterate://` directly: GitHub strips custom-scheme hrefs at
// render time, so raw deep links were scannable but never tappable.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { markdownAnnotator } from "../../packages/shared/src/dev/markdown-annotator.ts";
import { MobileChannelStatus } from "../../packages/shared/src/mobile-channel-status.ts";
import { mobileWebsiteEnvs } from "../../envs.ts";
import { getOctokit, getRepo } from "./github.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const mobileDir = path.join(repoRoot, "apps/mobile");

/** Release whose assets host the QR PNGs (already exists; images render
 * inline from release-download URLs, unlike API-posted attachments). */
const qrAssetsReleaseTag = "gh-attach-assets";

/** EAS channel names are much more restrictive than git branch names. */
export const channelForBranch = (branch: string) =>
  branch.toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-");

/** The tappable form of a preview-channel deep link (GitHub strips
 * custom-scheme hrefs, so markdown links bounce through this https page).
 * Channel only — the recommended backend + test login travel inside the
 * published bundle itself (apps/mobile/scripts/write-build-info.mjs), not
 * the link. */
export const interstitialUrl = (baseUrl: string, channel: string) =>
  // Bare path, not /m/: this is the universal-link prefix — a phone whose
  // binary carries the applinks entitlement opens the app DIRECTLY from
  // this href; everyone else gets the web interstitial bounce.
  `${baseUrl}/preview-channel/${channel}`;

/** The channel-stable install page (apps/os/src/routes/m.install.$channel.ts):
 * resolves the channel's expected native build at scan time from the status
 * snapshot below, so an install QR printed three pushes ago still works. */
export const installInterstitialUrl = (baseUrl: string, channel: string) =>
  `${baseUrl}/install/${channel}`;

/** The build's expo.dev page — the actual installer the interstitial links. */
export const expoBuildUrl = (input: { owner: string; slug: string; buildId: string }) =>
  `https://expo.dev/accounts/${input.owner}/projects/${input.slug}/builds/${input.buildId}`;

/** The mobile app's own web surface — every /m/* link and the snapshot
 * store live here, not on the os kernel (apps/mobile/website). */
export const mobileWebsiteBaseUrl = mobileWebsiteEnvs.prd.baseUrl;

/**
 * Push a channel's "expected native build" snapshot to prd OS, where the
 * /m/install interstitial and the app's staleness check read it (the worker
 * deliberately has no EXPO_TOKEN, so CI is its only source of EAS state).
 * Admin bearer: every mobile CI job already runs under
 * `doppler --project os --config prd`, which carries the secret. Failures
 * throw — a publish whose snapshot didn't land would leave install QRs
 * resolving to the previous build, which is exactly the silent drift this
 * store exists to kill.
 */
export async function pushChannelStatus(status: MobileChannelStatus) {
  const response = await fetch(`${mobileWebsiteBaseUrl}/m/channel-status/${status.channel}`, {
    method: "PUT",
    headers: { ...adminAuthHeader(), "content-type": "application/json" },
    body: JSON.stringify(status),
  });
  // 404 = the route isn't deployed yet (prd deploys on merge; PR publishes
  // can race the first deploy carrying it). The handler itself never 404s a
  // PUT for a channelForBranch-shaped name, so this is purely transitional —
  // warn loudly and let the publish proceed; any other failure is fatal.
  if (response.status === 404) {
    console.warn(
      `channel-status endpoint not deployed on ${mobileWebsiteBaseUrl} yet — snapshot skipped`,
    );
    return;
  }
  if (!response.ok) {
    throw new Error(`pushing channel status failed: ${response.status} ${await response.text()}`);
  }
  console.log(`pushed channel status for ${status.channel} (build ${status.buildId})`);
}

/** Read a channel's snapshot back (public endpoint); null when absent. */
export async function fetchChannelStatus(channel: string): Promise<MobileChannelStatus | null> {
  const response = await fetch(`${mobileWebsiteBaseUrl}/m/channel-status/${channel}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`fetching channel status failed: ${response.status} ${await response.text()}`);
  }
  return MobileChannelStatus.parse(await response.json());
}

/** Remove a closed PR's snapshot so its install interstitial falls back to
 * the honest "no publish snapshot" page. Tolerates absence. */
export async function deleteChannelStatus(channel: string) {
  const response = await fetch(`${mobileWebsiteBaseUrl}/m/channel-status/${channel}`, {
    method: "DELETE",
    headers: adminAuthHeader(),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`deleting channel status failed: ${response.status} ${await response.text()}`);
  }
  console.log(`deleted channel status for ${channel}`);
}

const adminAuthHeader = () => {
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET;
  if (!secret) {
    throw new Error("APP_CONFIG_ADMIN_API_SECRET is not set — run under doppler os/prd");
  }
  return { authorization: `Bearer ${secret}` };
};

export const run = (command: string, args: string[], cwd: string) =>
  execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// pnpm dlx prefixes install noise and eas-cli appends upgrade notices, so
// slice out the JSON payload rather than parsing the whole stream.
export const easJson = (args: string[]) => {
  const output = run(
    "pnpm",
    ["dlx", "eas-cli@21.0.1", ...args, "--non-interactive", "--json"],
    mobileDir,
  );
  const start = output.search(/[[{]/);
  const end = Math.max(output.lastIndexOf("]"), output.lastIndexOf("}"));
  if (start === -1 || end < start) {
    throw new Error(`no JSON found in eas output:\n${output}`);
  }
  return JSON.parse(output.slice(start, end + 1));
};

const inProgressStatuses = ["NEW", "IN_QUEUE", "IN_PROGRESS"];

/**
 * The runtime fingerprint `eas update` will compute for the working tree —
 * computed BEFORE stamping so write-build-info.mjs can bake it into the
 * bundle. Publishers assert the published runtime agreed, so a silent
 * divergence between this and eas-cli's own computation can't ship.
 */
export const computeRuntimeFingerprint = (): string => {
  // pnpm exec, not node_modules/.bin directly: the .bin entry is a shell
  // wrapper (running it under `node` is a syntax error on CI).
  const output = run(
    "pnpm",
    ["exec", "expo-updates", "fingerprint:generate", "--platform", "ios"],
    mobileDir,
  );
  // Same defensive JSON slicing as easJson — tool wrappers occasionally
  // prefix noise.
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw new Error(`no JSON found in fingerprint output:\n${output.slice(0, 500)}`);
  }
  const hash = JSON.parse(output.slice(start, end + 1)).hash;
  if (typeof hash !== "string" || !hash) {
    throw new Error(`fingerprint:generate returned no hash: ${output.slice(0, 500)}`);
  }
  return hash;
};

/**
 * The runtime a main-tracking phone is on — the baseline for the section's
 * "JS-only vs native changes" framing. Main's channel snapshot is the
 * authority: every build now shares the `preview` profile, so the raw
 * build list can't tell "a native-change PR's build just finished" from
 * "main moved runtimes", and using it flipped the heuristic for every
 * publish after any PR build landed. Falls back to the newest finished
 * build only while the snapshot doesn't exist yet (pre-store bootstrap),
 * where PR-build pollution is a bounded, self-healing inaccuracy.
 */
export const mainInstalledRuntime = async (): Promise<string | undefined> => {
  const status = await fetchChannelStatus("preview").catch((error) => {
    console.warn(`reading main's channel status failed (${error}) — falling back to build list`);
    return null;
  });
  if (status) return status.runtimeVersion;
  const builds: any[] = easJson([
    "build:list",
    "--platform",
    "ios",
    "--build-profile",
    "preview",
    "--status",
    // The flag wants lowercase; the JSON output reports uppercase. Sigh.
    "finished",
    "--limit",
    "1",
  ]);
  return builds[0]?.runtimeVersion;
};

export type InstallBuild = {
  id: string;
  gitCommitHash: string | undefined;
  /** False while the build is still queued or compiling: its install page
   * exists but has nothing to install yet, and the section says so rather
   * than offering a link that dead-ends. */
  finished: boolean;
  /** The .ipa artifact URL (stable, unsigned) — undefined until the build
   * finishes; the install page falls back to the build-page link without it. */
  ipaUrl: string | undefined;
};

/**
 * A native build that can run JS published for `runtime` — ANY channel.
 *
 * One build per unique runtime fingerprint, ever. Builds used to be baked
 * per PR channel so installing one landed you on the PR's JS in a single
 * step (#2542) — a ~20-minute paid EAS build per PR, almost always for zero
 * native changes. Now every build is the plain `preview` profile and the
 * channel hop after an install is one tap on the /m/install interstitial's
 * "Open in app" link. JS-only PRs (runtime matches an existing build)
 * trigger nothing; a native-change PR triggers the one build main will
 * reuse after merge.
 */
export const ensureBuildForRuntime = (input: { runtime: string }): InstallBuild => {
  const builds: any[] = easJson([
    "build:list",
    "--platform",
    "ios",
    "--build-profile",
    "preview",
    "--runtime-version",
    input.runtime,
    "--limit",
    "30",
  ]);
  // Finished first: a queued build's install page has nothing to install.
  const build =
    builds.find((b) => b.status === "FINISHED") ||
    builds.find((b) => inProgressStatuses.includes(b.status)) ||
    triggerBuild(input);
  if (!build?.id) {
    throw new Error(`could not find or trigger an install build: ${JSON.stringify(build)}`);
  }
  return {
    id: build.id,
    gitCommitHash: build.gitCommitHash,
    finished: build.status === "FINISHED",
    // || undefined: EAS reports null (not absent) on in-progress builds, and
    // the snapshot schema rejects null — undefined serializes to an absent
    // key, which means "fall back to the build page".
    ipaUrl: build.artifacts?.applicationArchiveUrl || undefined,
  };
};

const triggerBuild = (input: { runtime: string }) => {
  console.log(`no preview build for runtime ${input.runtime} — triggering one`);
  const triggered = easJson(["build", "--platform", "ios", "--profile", "preview", "--no-wait"]);
  return Array.isArray(triggered) ? triggered[0] : triggered;
};

export type PreviewPlan = {
  /** Does the published JS run on the binary a phone already has installed? */
  runtimeMatchesInstalled: boolean;
  channel: string;
  /** Https interstitial that bounces to iterate://preview-channel/<channel> —
   * the TAP path (GitHub strips custom-scheme hrefs, so links need https). */
  deepLinkUrl: string;
  /** Raw app-scheme URL — the SCAN path. The camera opens custom schemes
   * directly, so QR codes encode this and skip the interstitial hop. */
  otaQrContent: string;
  installUrl: string;
  /** The install build has finished and can actually be installed. */
  installReady: boolean;
};

export const planPreview = (input: {
  baseUrl: string;
  /** The app's URL scheme (app.json `scheme`, i.e. "iterate"). */
  scheme: string;
  channel: string;
  publishedRuntime: string;
  /** Runtime of the newest FINISHED preview-profile build — what's installable today. */
  installedRuntime: string | undefined;
  /** The channel-stable /m/install/<channel> interstitial — it resolves the
   * channel's expected build (possibly freshly triggered, hence
   * installReady) at scan time. */
  installUrl: string;
  installReady: boolean;
}): PreviewPlan => ({
  runtimeMatchesInstalled: input.publishedRuntime === input.installedRuntime,
  channel: input.channel,
  deepLinkUrl: interstitialUrl(input.baseUrl, input.channel),
  otaQrContent: `${input.scheme}://preview-channel/${input.channel}`,
  installUrl: input.installUrl,
  installReady: input.installReady,
});

const qrDetails = (opts: {
  open: boolean;
  summary: string;
  qrImageUrl: string;
  href: string;
  caption: string;
  /** Fine print under the QR — "" for none. */
  note: string;
}) =>
  [
    `<details${opts.open ? " open" : ""}><summary>${opts.summary}</summary>`,
    "",
    // The caption is the tap path (phone reading the page); the QR is the
    // scan path (phone pointed at another screen). The <a> around the img is
    // best-effort - GitHub's mobile app opens images fullscreen regardless.
    `**[${opts.caption}](${opts.href})**`,
    "",
    `<a href="${opts.href}"><img src="${opts.qrImageUrl}" width="90" alt="QR code" /></a>`,
    "",
    ...(opts.note ? [`<sub>${opts.note}</sub>`, ""] : []),
    "</details>",
  ].join("\n");

export const renderPreviewSection = (input: {
  variant: "pr" | "main";
  plan: PreviewPlan;
  deepLinkQrUrl: string;
  installQrUrl: string;
  headSha: string;
  /** Commit the install build was compiled from — often older than headSha
   * when a still-compatible build is reused. */
  installBuildSha: string | undefined;
  publishedRuntime: string;
}) => {
  const { plan } = input;
  const forMain = input.variant === "main";
  return [
    forMain ? "## 📱 Mobile preview — main" : "## 📱 Mobile preview",
    "",
    `Channel \`${plan.channel}\` · runtime \`${input.publishedRuntime.slice(0, 9)}\` · ${
      plan.runtimeMatchesInstalled
        ? "**JS-only** — the installed app can run it"
        : "**native changes** — needs a fresh install"
    }`,
    "",
    qrDetails({
      open: plan.runtimeMatchesInstalled,
      summary: forMain
        ? `OTA — default-channel phones pull this automatically (\`${input.headSha.slice(0, 7)}\`)`
        : `OTA — switch the installed app to this PR's channel (\`${input.headSha.slice(0, 7)}\`)`,
      qrImageUrl: input.deepLinkQrUrl,
      href: plan.deepLinkUrl,
      caption: forMain
        ? "Switch this phone back to the default channel now"
        : "Switch this phone to the PR channel",
      note: "",
    }),
    qrDetails({
      open: !plan.runtimeMatchesInstalled,
      summary: `Full install — if the app is uninstalled or the runtime differs (\`${
        input.installBuildSha?.slice(0, 7) || "unknown sha"
      }\`)`,
      qrImageUrl: input.installQrUrl,
      href: plan.installUrl,
      caption: plan.installReady
        ? "Open the install page"
        : "Build still running — the install page fills in when it finishes",
      // Builds are shared across channels (one per runtime fingerprint), so
      // the install page sequences the channel hop: install, then its
      // "Open in app" tap lands you on this channel.
      note: forMain
        ? ""
        : `After installing, tap <b>Open in app</b> on that page to land on <code>${plan.channel}</code>.`,
    }),
    "",
    forMain
      ? `<sub>Posted by mobile-eas-update on merges touching apps/mobile.</sub>`
      : `<sub>Back to main inside the app: Build info → Switch to main. Republishes on every push to this PR.</sub>`,
  ].join("\n");
};

/** markdownAnnotator label for the managed PR-body preview section. Lives
 * here (not in the PR publisher) so the cleanup and merge-push writers can
 * import it without a cycle. */
export const bodySectionLabel = "mobile-pr-preview";

/** Marker making main-section commit-comment updates idempotent across
 * re-runs. Lives here because the merge-push publisher and the build-completion
 * refresher both write the comment via syncMainPreviewSection below. */
export const commitCommentMarker = "<!-- mobile-preview -->";

/** True when a PR-body section already carries the main variant — the guard
 * that keeps the close-event cleanup from clobbering a merge-push publish
 * that won the race. */
export const isMainFlavoredSection = (current: string) => current.includes("Mobile preview — main");

/**
 * Write main's rendered section into every place a merged commit should
 * surface it: the commit comment, and the body section of each MERGED PR the
 * commit belongs to (skipping PRs that never had a mobile preview). Runs
 * from the merge-push publisher and again from the build-completion
 * refresher, so it is idempotent by construction.
 */
export async function syncMainPreviewSection(input: { sha: string; section: string }) {
  const github = getOctokit();
  const repo = getRepo();
  const body = `${commitCommentMarker}\n${input.section}`;
  const { data: existing } = await github.rest.repos.listCommentsForCommit({
    ...repo,
    commit_sha: input.sha,
  });
  const mine = existing.find((c) => c.body?.includes(commitCommentMarker));
  if (mine) {
    await github.rest.repos.updateCommitComment({ ...repo, comment_id: mine.id, body });
    console.log(`updated commit comment on ${input.sha.slice(0, 9)}`);
  } else {
    await github.rest.repos.createCommitComment({ ...repo, commit_sha: input.sha, body });
    console.log(`posted commit comment on ${input.sha.slice(0, 9)}`);
  }

  const { data: assocPrs } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
    ...repo,
    commit_sha: input.sha,
  });
  for (const pr of assocPrs) {
    if (!pr.merged_at) continue;
    // Fresh body — the association payload's copy may be stale.
    const { data: fresh } = await github.rest.pulls.get({ ...repo, pull_number: pr.number });
    const annotator = markdownAnnotator(fresh.body || "", bodySectionLabel);
    // Only PRs that had a mobile preview get the swap; others are untouched.
    if (annotator.current === null) continue;
    await github.rest.pulls.update({
      ...repo,
      pull_number: pr.number,
      body: annotator.update(input.section),
    });
    console.log(`wrote main's preview section into merged PR #${pr.number}`);
  }
}

export async function uploadQrAsset(name: string, url: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "mobile-pr-qr-"));
  const file = path.join(dir, name);
  writeFileSync(file, await QRCode.toBuffer(url, { width: 512, margin: 2 }));
  const github = getOctokit();
  const repo = getRepo();
  const release = await github.rest.repos.getReleaseByTag({ ...repo, tag: qrAssetsReleaseTag });
  const existing = release.data.assets.find((a) => a.name === name);
  if (existing) {
    // Re-runs on the same sha: content is identical (URL-derived), keep it.
    return existing.browser_download_url;
  }
  const uploaded = await github.rest.repos.uploadReleaseAsset({
    ...repo,
    release_id: release.data.id,
    name,
    // Octokit types want a string; the payload is binary and passes through fine.
    data: readFileSync(file) as unknown as string,
    headers: { "content-type": "image/png", "content-length": String(readFileSync(file).length) },
  });
  return uploaded.data.browser_download_url;
}
