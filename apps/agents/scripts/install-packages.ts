// scripts/install-packages.ts — install or upgrade the agents app, and optionally voice, in an
// existing project the package way: the config repo's `agents/` (and `voice/`) folder becomes
// exactly the pinned package.json and the re-export (a copied runtime's other files are deleted),
// root code that imported the copied runtime's installer imports `@iterate-com/agents/install`
// instead (with the root package.json listing it), ONE commit, then `installAgents` and
// `installVoice` from that commit and a check that `itx.agents` (and `itx.voice.health()`)
// answer. It prints the plan and changes nothing without --apply. Old voice bundles in project KV
// (`voice/<sha256>/…`) are left where they are: a past call's facets name them.
//
//   WORKER_BASE_URL=https://os.iterate.com APP_CONFIG_ADMIN_API_SECRET=… \
//   pnpm exec tsx scripts/install-packages.ts --project prj_… \
//     --agents https://pkg.pr.new/iterate/iterate/@iterate-com/agents@<sha> \
//     [--voice https://pkg.pr.new/iterate/iterate/@iterate-com/voice@<sha>] [--apply]
//
// ITERATE_BEARER_TOKEN (a personal access token for the project) works instead of the operator
// secret.
import { parseArgs } from "node:util";
import { agentsFolder, installAgents, rootManifestListing } from "@iterate-com/agents/install";
import { installVoice, voiceFolder } from "@iterate-com/voice/install";
import type { RepoFileChange, RepoHandle } from "iterate/api";
import { credentials, disposeSessions, session } from "./client.ts";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    agents: { type: "string" },
    voice: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
const { project, agents, voice, apply } = values;
if (!project || !agents)
  throw new Error("--project <id> and --agents <version> are required (--voice optional)");

const root = session().authenticate(credentials()).projects.get(project);
const repo: RepoHandle = root.repos.get("/repos/config");
const { paths } = await repo.listFiles();
const changes: RepoFileChange[] = [];

/** `dir/` becomes exactly `files`. */
const replaceFolder = (dir: string, files: Record<string, string>) => {
  for (const path of paths)
    if (path.startsWith(`${dir}/`) && !Object.hasOwn(files, path.slice(dir.length + 1)))
      changes.push({ path, delete: true });
  for (const [name, content] of Object.entries(files))
    changes.push({ path: `${dir}/${name}`, content });
};
replaceFolder("agents", agentsFolder(agents));
if (voice) replaceFolder("voice", voiceFolder(voice));

// The project's own code, outside the app folders: the old template's worker imported the copied
// runtime's installer, which the package now provides. Any other import of the folder is refused.
const OLD_INSTALLER = /(["'])\.\/agents\/install(?:\.ts|\.js)?\1/g;
let importsInstaller = false;
for (const path of paths) {
  if (!/\.(m?ts|m?js)$/.test(path) || /^(agents|voice)\//.test(path)) continue;
  const text = await repo.readFile(path);
  if (!text) continue;
  const rewritten = text.replace(OLD_INSTALLER, '"@iterate-com/agents/install"');
  const left = rewritten.match(/["'](?:\.\.?\/)+(?:agents|voice)\/[^"']*["']/g);
  if (left) throw new Error(`${path} imports ${left.join(", ")} from an app folder; move it first`);
  if (rewritten === text) continue;
  changes.push({ path, content: rewritten });
  importsInstaller = true;
}
// The root lists each app's package: at runtime when its code imports the installer, else as a
// devDependency, so `tsc` over the repo resolves the folders' imports.
const manifestBefore = await repo.readFile("package.json");
let manifest = manifestBefore;
if (importsInstaller) {
  const parsed = JSON.parse(manifest || "{}");
  parsed.dependencies = { ...parsed.dependencies, "@iterate-com/agents": agents };
  manifest = `${JSON.stringify(parsed, null, 2)}\n`;
}
for (const [name, version] of [
  ["@iterate-com/agents", agents],
  ...(voice ? [["@iterate-com/voice", voice]] : []),
] as const)
  manifest = rootManifestListing(manifest, name, version) ?? manifest;
if (manifest !== manifestBefore) changes.push({ path: "package.json", content: manifest! });

console.log(`${project}: ${changes.length} changes to /repos/config`);
for (const change of changes)
  console.log(`  ${"delete" in change ? "delete" : "write "} ${change.path}`);
if (!apply) {
  console.log("dry run: pass --apply to commit and install");
} else {
  const { commitOid } = await repo.commitFiles({
    message: `Install @iterate-com/agents${voice ? " and @iterate-com/voice" : ""} as packages`,
    changes,
  });
  // A commit that changed nothing (already migrated) installs from the tip.
  const at = commitOid || undefined;
  console.log(`committed ${commitOid || "nothing (the repo already had these files)"}`);
  await installAgents(root, await repo.modules({ dir: "agents", commitOid: at }));
  console.log("agents installed:", await root.agents.list());
  if (voice) {
    await installVoice(root, await repo.modules({ dir: "voice", commitOid: at }));
    console.log("voice installed:", await root.voice.health());
  }
}
disposeSessions();
process.exit(0);
