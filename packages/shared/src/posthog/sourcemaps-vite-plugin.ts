import type { PluginOption } from "vite";

const LOG_PREFIX = "[posthog-sourcemaps-vite-plugin]";

function logLine(message: string) {
  console.log(`${LOG_PREFIX} ${message}`);
}

export interface PosthogSourcemapPluginOptions {
  /** PostHog personal API key (`phx_…`) for source map uploads. */
  apiKey?: string;
  /** PostHog project id (dashboard project id). */
  projectId?: string;
  /**
   * Release name for source map grouping in PostHog (e.g. `iterate-example`, `iterate-os`).
   * Maps to `@posthog/rollup-plugin` `sourcemaps.releaseName`.
   */
  releaseName: string;
  /** PostHog ingest host (default `https://eu.i.posthog.com`). */
  host?: string;
  /**
   * Release version for uploaded maps.
   *
   * PostHog release docs: https://posthog.com/docs/error-tracking/releases
   * PostHog web sourcemap docs: https://posthog.com/docs/error-tracking/upload-source-maps/web
   *
   * PostHog uses the injected release metadata to match captured exceptions to
   * the uploaded symbol set. We keep this explicit and stable for now instead
   * of deriving from git.
   */
  releaseVersion?: string;
}

/**
 * PostHog source map upload via `@posthog/rollup-plugin`: injects chunk metadata into the
 * bundle, uploads `.map` files to PostHog, then deletes local `.map` files so they are not
 * served publicly. Inactive when `apiKey` or `projectId` is missing.
 *
 * First-party docs:
 * - https://posthog.com/docs/error-tracking/releases
 * - https://posthog.com/docs/error-tracking/upload-source-maps/web
 *
 * Resolves to a {@link PluginOption}. Use as a single entry in
 * `plugins: [..., posthogSourcemaps({ … })]` — Vite flattens it.
 */
export async function posthogSourcemaps(
  options: PosthogSourcemapPluginOptions,
): Promise<PluginOption> {
  const apiKey = options.apiKey?.trim();
  const projectId = options.projectId?.trim();
  if (!apiKey || !projectId) {
    logLine(
      "Skipping PostHog source map upload: `apiKey` or `projectId` is missing (set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID in the environment).",
    );
    return [];
  }

  const host = options.host ?? "https://eu.i.posthog.com";
  const releaseVersion = options.releaseVersion?.trim() || "latest";
  const { releaseName } = options;

  logLine(
    `PostHog source map upload enabled: releaseName "${releaseName}", PostHog project id ${projectId}, host ${host}.`,
  );
  logLine(
    `Will upload generated source maps after each production Rollup build for releaseVersion "${releaseVersion}", then delete .map files from the output (deleteAfterUpload: true).`,
  );

  const { default: posthog } = await import("@posthog/rollup-plugin");
  return [
    posthog({
      personalApiKey: apiKey,
      projectId,
      host,
      sourcemaps: {
        enabled: true,
        releaseName,
        releaseVersion,
        deleteAfterUpload: true,
      },
    }),
  ] as PluginOption;
}
