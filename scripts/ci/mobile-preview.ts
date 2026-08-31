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
import { envs } from "../../envs.ts";
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
  `${baseUrl}/m/preview-channel/${channel}`;

/** Production OS — the phone's app talks to prd, so QR links do too. */
export const prdBaseUrl = envs.prd.baseUrl;

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
 * Bake a channel into the build profile before building.
 *
 * `eas build` has no `--channel` flag (eas-cli 21.0.1) and the channel must
 * reach the binary — it ends up in Expo.plist — so CI writes the profile and
 * lets eas-cli upload the working tree, exactly as it already does for
 * src/build-info.json. Pure so the rewrite is testable without eas.
 *
 * This is only safe for the runtime version because
 * apps/mobile/fingerprint.config.js ignores eas.json. Without that ignore the
 * rewritten file would move the fingerprint and the resulting binary would
 * refuse the very updates this PR publishes.
 */
export const easJsonWithChannel = (raw: string, profile: string, channel: string) => {
  const parsed = JSON.parse(raw);
  if (!parsed.build?.[profile]) {
    throw new Error(`eas.json has no build profile "${profile}"`);
  }
  parsed.build[profile].channel = channel;
  return `${JSON.stringify(parsed, null, 2)}\n`;
};

/** Run `fn` with the profile's channel rewritten, then put eas.json back —
 * CI checkouts are ephemeral, but a restored tree keeps local runs honest. */
const withProfileChannel = <T>(profile: string, channel: string, fn: () => T): T => {
  const easJsonPath = path.join(mobileDir, "eas.json");
  const original = readFileSync(easJsonPath, "utf8");
  writeFileSync(easJsonPath, easJsonWithChannel(original, profile, channel));
  try {
    return fn();
  } finally {
    writeFileSync(easJsonPath, original);
  }
};

/** Runtime of the newest finished preview build — what a phone can be running today. */
export const latestInstalledRuntime = (): string | undefined => {
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
};

/**
 * A build that both runs JS published for `runtime` AND boots on `channel`.
 *
 * The channel half is the point: an install used to hand you a binary whose
 * own channel was `preview` (main), so installing a PR's build ran main's JS
 * until you went back and scanned the OTA link too. Matching on channel — and
 * building one when nothing matches — makes the install QR mean what it says.
 *
 * One build per PR branch, not per push: later pushes find this build and
 * ride OTA.
 */
export const ensureBuildForPr = (input: { channel: string; runtime: string }): InstallBuild => {
  const builds: any[] = easJson([
    "build:list",
    "--platform",
    "ios",
    "--build-profile",
    buildProfileForChannel(input.channel),
    "--runtime-version",
    input.runtime,
    "--limit",
    "30",
  ]);
  const onChannel = builds.filter((b) => b.channel === input.channel);
  // Finished first: a queued build's install page has nothing to install.
  const build =
    onChannel.find((b) => b.status === "FINISHED") ||
    onChannel.find((b) => inProgressStatuses.includes(b.status)) ||
    triggerBuild(input);
  if (!build?.id) {
    throw new Error(`could not find or trigger an install build: ${JSON.stringify(build)}`);
  }
  return {
    id: build.id,
    gitCommitHash: build.gitCommitHash,
    finished: build.status === "FINISHED",
  };
};

/** Main keeps its long-lived `preview` profile; PR channels go through
 * `preview-pr`, whose channel this run rewrites. */
const buildProfileForChannel = (channel: string) =>
  channel === "preview" ? "preview" : "preview-pr";

const triggerBuild = (input: { channel: string; runtime: string }) => {
  const profile = buildProfileForChannel(input.channel);
  console.log(
    `no ${profile} build on channel ${input.channel} for runtime ${input.runtime} — triggering one`,
  );
  const triggered = withProfileChannel(profile, input.channel, () =>
    easJson(["build", "--platform", "ios", "--profile", profile, "--no-wait"]),
  );
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
  /** Install page of the build serving this update: one whose runtime AND
   * channel match (may be freshly triggered, hence installReady). */
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
        ? "Open the EAS build install page"
        : "Build still running — the install page fills in when it finishes",
      // The build is built FOR this channel, so installing it is being on
      // this channel. No second scan, and no order to get wrong.
      note: forMain
        ? ""
        : `This build boots on <code>${plan.channel}</code> — installing it is all you need.`,
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
