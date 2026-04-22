/**
 * Build apps locally using esbuild + npm install, then sync to artifact repo.
 * This sidesteps the DO memory limit for large bundles (e.g., agents SDK).
 *
 * Usage: npx tsx scripts/build-local.ts [appName]
 */
import { execSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, relative } from "node:path";
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BASE_TEMPLATE = join(__dirname, "../base-template");
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "cc7f6f461fbe823c199da2b27f9e0ff3";
const PROJECT_HOST = process.env.PROJECT_HOST || "test.iterate-dev-jonas.app";

const config = JSON.parse(readFileSync(join(BASE_TEMPLATE, "config.json"), "utf8")) as {
  apps: string[];
};

async function buildApp(appName: string) {
  const appDir = join(BASE_TEMPLATE, "apps", appName);
  if (!existsSync(appDir)) {
    console.log(`  ${appName}: skipped (no directory)`);
    return;
  }

  const hasWorkerTs = existsSync(join(appDir, "worker.ts"));
  const hasClientTsx = existsSync(join(appDir, "client.tsx"));
  const hasIndexJs = existsSync(join(appDir, "index.js"));
  const hasPkgJson = existsSync(join(appDir, "package.json"));

  // Install npm deps if package.json exists
  if (hasPkgJson) {
    console.log(`  ${appName}: installing deps...`);
    execSync("npm install --no-package-lock --legacy-peer-deps 2>/dev/null || true", {
      cwd: appDir,
      stdio: "pipe",
    });
  }

  const distDir = join(appDir, "dist");
  if (existsSync(distDir)) rmSync(distDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });

  if (hasWorkerTs) {
    // Bundle server (worker.ts)
    console.log(`  ${appName}: bundling worker.ts...`);
    await esbuild.build({
      entryPoints: [join(appDir, "worker.ts")],
      bundle: true,
      outfile: join(distDir, "bundle.js"),
      format: "esm",
      platform: hasPkgJson
        ? (JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).buildConfig
            ?.esbuildPlatform ?? "neutral")
        : "neutral",
      target: "es2022",
      external: [
        "cloudflare:workers",
        "cloudflare:*",
        "node:*",
        "path",
        // App-declared externals from package.json buildConfig
        ...(hasPkgJson
          ? (JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).buildConfig
              ?.externals ?? [])
          : []),
      ],
      // App-declared esbuild conditions (e.g. workerd,worker,browser for tree-shaking)
      conditions: hasPkgJson
        ? (JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).buildConfig
            ?.esbuildConditions ?? [])
        : [],
      treeShaking: true,
      define: {
        "process.env.NODE_ENV": '"production"',
      },
      jsx: "automatic",
      jsxImportSource: "react",
      nodePaths: [join(appDir, "node_modules")],
      logLevel: "warning",
    });

    const manifest: any = {
      builtAt: new Date().toISOString(),
      mainModule: "bundle.js",
      moduleFiles: ["bundle.js"],
      assetFiles: [] as string[],
    };

    if (hasClientTsx) {
      // Bundle client (client.tsx) with splitting to keep chunks under 1MB
      console.log(`  ${appName}: bundling client.tsx...`);
      await esbuild.build({
        entryPoints: [join(appDir, "client.tsx")],
        bundle: true,
        outdir: join(distDir, "assets"),
        splitting: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        jsx: "automatic",
        jsxImportSource: "react",
        nodePaths: [join(appDir, "node_modules")],
        logLevel: "warning",
        chunkNames: "[name]-[hash]",
      });

      // Collect all generated asset files
      const assetDir = join(distDir, "assets");
      const assetFiles = readdirSync(assetDir).map((f) => "assets/" + f);

      // Generate index.html
      const htmlTemplate = existsSync(join(appDir, "index.html"))
        ? readFileSync(join(appDir, "index.html"), "utf8")
        : '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>';
      const html = htmlTemplate.replace(
        "</body>",
        '<script type="module" src="/assets/client.js"></script></body>',
      );
      writeFileSync(join(assetDir, "index.html"), html);
      assetFiles.push("assets/index.html");

      manifest.assetFiles = assetFiles;
    }

    writeFileSync(join(distDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(
      `  ${appName}: OK (${manifest.moduleFiles.length} modules, ${manifest.assetFiles.length} assets)`,
    );
  } else if (hasIndexJs) {
    // Plain JS app — no bundling needed, just copy
    console.log(`  ${appName}: plain JS (no build needed)`);
  } else {
    console.log(`  ${appName}: skipped (no worker.ts or index.js)`);
  }
}

async function main() {
  const only = process.argv[2];
  const apps = only ? [only] : config.apps;

  console.log("Building apps locally...");
  for (const app of apps) {
    try {
      await buildApp(app);
    } catch (e: any) {
      console.error(`  ${app}: FAILED — ${e.message}`);
      if (e.errors)
        console.error("  esbuild errors:", JSON.stringify(e.errors, null, 2).slice(0, 500));
    }
  }

  // Sync source files to artifact repo (no dist — too large for git-in-SQLite)
  console.log("\nSyncing source to artifact repo...");
  execSync(
    `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT_ID} npx tsx scripts/sync-base-artifact.ts ./base-template`,
    { stdio: "inherit", cwd: join(__dirname, "..") },
  );

  // Rebase project
  console.log("\nRebasing project...");
  const rebaseResp = await fetch(`https://${PROJECT_HOST}/api/rebase?force=1`, {
    method: "POST",
    headers: { "x-level": "project" },
  });
  const rebaseData = (await rebaseResp.json()) as any;
  console.log("  rebase:", rebaseData.ok);

  // Upload dist files directly to the Project DO (bypasses git size limits)
  console.log("\nUploading dist files...");
  for (const app of apps) {
    const distDir = join(BASE_TEMPLATE, "apps", app, "dist");
    if (!existsSync(distDir)) continue;
    const distFiles = readDirRecursive(distDir);
    for (const [relPath, content] of Object.entries(distFiles)) {
      const apiPath = `apps/${app}/dist/${relPath}`;
      const resp = await fetch(`https://${PROJECT_HOST}/api/files/${encodeURIComponent(apiPath)}`, {
        method: "PUT",
        headers: { "x-level": "project", "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const result = (await resp.json()) as any;
      if (!result.ok) console.error(`    FAILED: ${apiPath}`, result.error);
    }
    console.log(`  ${app}: ${Object.keys(distFiles).length} dist files uploaded`);
  }

  function readDirRecursive(dir: string, base: string = dir): Record<string, string> {
    const files: Record<string, string> = {};
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(base, full);
      const stat = statSync(full);
      if (stat.isDirectory()) Object.assign(files, readDirRecursive(full, base));
      else files[rel] = readFileSync(full, "utf8");
    }
    return files;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
