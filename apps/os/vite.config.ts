import { execSync } from "node:child_process";
import { defineConfig, type PluginOption } from "vite";
import tailwindcss from "@tailwindcss/vite";
import alchemy from "alchemy/cloudflare/tanstack-start";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { devtools } from "@tanstack/devtools-vite";
import { vitePublicUrl } from "@iterate-com/shared/force-public-url-vite-plugin";
import viteTsConfigPaths from "vite-tsconfig-paths";

/**
 * PostHog source map upload plugin — only active when POSTHOG_PERSONAL_API_KEY
 * and POSTHOG_PROJECT_ID env vars are set (CI deploys). Injects chunk-id metadata
 * into bundled JS so PostHog can match errors to source maps, uploads the .map
 * files, then deletes them so they aren't served publicly.
 */
async function posthogSourcemaps(): Promise<PluginOption[]> {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  if (!apiKey || !projectId) return [];

  const stage = process.env.STAGE ?? process.env.APP_STAGE ?? process.env.VITE_APP_STAGE;
  const githubRefType = process.env.GITHUB_REF_TYPE;
  const githubRefName = process.env.GITHUB_REF_NAME;
  const githubTag = githubRefType === "tag" ? githubRefName : undefined;
  const githubSha = process.env.GITHUB_SHA;
  const explicitReleaseName = process.env.RELEASE_NAME ?? process.env.POSTHOG_RELEASE_NAME;
  let gitSha: string | undefined;
  try {
    gitSha = execSync("git rev-parse --short=12 HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    // git may not be available (e.g. some CI/build environments)
  }
  const versionId =
    explicitReleaseName ??
    githubTag ??
    githubSha?.slice(0, 12) ??
    (gitSha?.trim() || `ts-${Date.now()}`);
  const project = "iterate-os";
  const version =
    explicitReleaseName || githubTag ? versionId : [stage, versionId].filter(Boolean).join("-");

  const { default: posthog } = await import("@posthog/rollup-plugin");
  return [
    posthog({
      personalApiKey: apiKey,
      envId: projectId,
      host: "https://eu.i.posthog.com",
      sourcemaps: {
        enabled: true,
        project,
        version,
        deleteAfterUpload: true,
      },
    }),
  ];
}

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  build: {
    sourcemap: true,
    minify: "terser",
    terserOptions: {
      mangle: false,
    },
  },
  server: {
    host: "0.0.0.0",
    cors: false,
    strictPort: false,
    allowedHosts: [
      "host.docker.internal",
      ".iterate.com",
      ".iterate.app",
      ".iterate-dev.com",
      ".iterate-dev.app",
    ],
  },
  plugins: [
    {
      name: "iterate-os-banner",
      configureServer(server) {
        const _printUrls = server.printUrls;
        server.printUrls = () => {
          server.config.logger.info("\n  iterate os server ready\n");
          _printUrls();
        };
      },
    },
    // @ts-expect-error - version mismatch
    vitePublicUrl(),
    devtools({
      eventBusConfig: {
        // Port 0 enables auto-assigned port (default behavior)
        port: 0,
      },
    }),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    alchemy(),
    tailwindcss(),
    tanstackStart({
      srcDirectory: "./app",
      router: {
        addExtensions: true,
      },
    }),
    viteReact(),
    posthogSourcemaps(),
  ],
  define: {
    "import.meta.vitest": "undefined",
  },
});
