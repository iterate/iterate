// Point a project's config repo at the voice agent package.
//
// The guest worker is @iterate-com/voice-agent: a project's config repo
// declares the package and re-exports the agent from a three-line
// voice-agent.ts, which the platform builds like any file in the repo. This
// command writes those lines and prints the commit it made. Before the
// package existed it committed the agent's source files into every project;
// `--prune-legacy` deletes the ones beside voice-agent.ts from a repo that
// still carries them, since nothing builds from them any more.
//
//   doppler run --config preview_3 -- pnpm cli voicelab deploy --project prj_…
//   doppler run --config prd -- pnpm cli voicelab deploy --project iterate --prune-legacy
//   pnpm cli voicelab deploy --project iterate --spec https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@<sha>
import {
  installVoiceAgent,
  legacyGuestPaths,
  removeLegacyGuest,
  VOICE_AGENT_PACKAGE_NAME,
  VOICE_AGENT_ZOD_SPEC,
  type VoiceAgentConfigRepo,
} from "@iterate-com/voice-agent";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { buildLocalVoiceAgentArtifact } from "./local-voice-agent-source.ts";
import { withRpcResult } from "./rpc-ownership.ts";

/** Options for `pnpm cli voicelab deploy`. */
export interface DeployOptions extends VoicelabConnectOptions {
  /** Dependency spec to write. Defaults to the package's main build on pkg.pr.new. */
  spec?: string;
  /** Commit message. */
  message?: string;
  /** Also delete the source files an older deploy committed. */
  pruneLegacy?: boolean;
  /** Bundle this checkout's voice worker into the config repo for a local preview. */
  localSource?: boolean;
}

/**
 * The config repo as the installer wants it, over this CLI's Cap'n Web
 * connection: every RPC result is read once and released — the discipline
 * rpc-ownership.ts owns — so the package never learns about the transport.
 */
export function voiceAgentConfigRepo(itx: unknown): VoiceAgentConfigRepo {
  /* connectProject hands back the project's root handle untyped (the
   * generated client type lives in apps/os, not in what scripts import); the
   * two methods used here are the itx contract's own. */
  const repo = (itx as { repo: VoiceAgentConfigRepo }).repo;
  return {
    readFile: (input) =>
      withRpcResult(repo.readFile(input), (file) =>
        file === null ? null : { commitOid: file.commitOid, content: file.content },
      ),
    commitFiles: (input) =>
      withRpcResult(repo.commitFiles(input), ({ commitOid, changedPaths, noChanges }) => ({
        commitOid,
        changedPaths: [...changedPaths],
        noChanges,
      })),
  };
}

/**
 * Replace the package entrypoint with one auditable local bundle. The normal
 * config repo already supplies `iterate`; `zod` is added when absent. Removing
 * the package declaration means the preview cannot accidentally select a
 * published voice-agent build instead of the displayed artifact hash.
 */
export async function installLocalVoiceAgentSource(
  repo: VoiceAgentConfigRepo,
  source: string,
  message?: string,
): Promise<{ changed: boolean; commitOid: string; changedPaths: string[] }> {
  const [manifest, guest] = await Promise.all([
    repo.readFile({ path: "package.json" }),
    repo.readFile({ path: "voice-agent.ts" }),
  ]);
  if (manifest === null) throw new Error("The config repo has no package.json.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.content);
  } catch (error) {
    throw new Error(`package.json is not valid JSON: ${String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("package.json must hold a JSON object.");
  }
  const packageJson = parsed as Record<string, unknown>;
  const dependencies = packageJson.dependencies;
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new Error("package.json dependencies must hold an object.");
  }
  const nextDependencies = { ...(dependencies as Record<string, unknown>) };
  if (typeof nextDependencies.iterate !== "string") {
    throw new Error("Local voice-agent source requires package.json dependencies.iterate.");
  }
  if (nextDependencies.zod === undefined) nextDependencies.zod = VOICE_AGENT_ZOD_SPEC;
  delete nextDependencies[VOICE_AGENT_PACKAGE_NAME];
  const nextManifest = `${JSON.stringify({ ...packageJson, dependencies: nextDependencies }, null, 2)}\n`;
  const changes = [
    ...(nextManifest === manifest.content ? [] : [{ path: "package.json", content: nextManifest }]),
    ...(guest?.content === source ? [] : [{ path: "voice-agent.ts", content: source }]),
  ];
  if (changes.length === 0) {
    return { changed: false, changedPaths: [], commitOid: manifest.commitOid };
  }
  const commit = await repo.commitFiles({
    changes,
    message: message ?? "voice-agent: install local source artifact for preview",
  });
  return {
    changed: !commit.noChanges,
    changedPaths: changes.map((change) => change.path),
    commitOid: commit.commitOid,
  };
}

export async function deploy(options: DeployOptions) {
  using itx = await connectProject(options);
  const repo = voiceAgentConfigRepo(itx);
  if (options.localSource === true) {
    if (options.spec !== undefined) {
      throw new Error("--local-source and --spec are mutually exclusive.");
    }
    if (options.pruneLegacy === true) {
      throw new Error("--local-source and --prune-legacy are mutually exclusive.");
    }
    const artifact = await buildLocalVoiceAgentArtifact();
    const install = await installLocalVoiceAgentSource(repo, artifact.source, options.message);
    console.log(
      install.changed
        ? `committed ${install.commitOid.slice(0, 8)} (${install.changedPaths.join(", ")}): local voice-agent sha256 ${artifact.sha256}`
        : `no change — the repo already names local voice-agent sha256 ${artifact.sha256} (${install.commitOid.slice(0, 8)})`,
    );
    console.log("restart the parent conversation stream before calling the updated hosted facet");
    return;
  }
  const install = await installVoiceAgent(repo, {
    spec: options.spec,
    existing: "replace",
    message: options.message,
  });
  console.log(
    install.changed
      ? `committed ${install.commitOid.slice(0, 8)} (${install.changedPaths.join(", ")}): the repo names ${install.spec}`
      : `no change — the repo already names ${install.spec} (${install.commitOid.slice(0, 8)})`,
  );
  if (options.pruneLegacy === true) {
    const removed = await removeLegacyGuest(repo);
    console.log(
      removed === null
        ? "no committed copy of the agent to remove"
        : `committed ${removed.commitOid.slice(0, 8)}: removed ${removed.paths.join(", ")}`,
    );
  } else {
    const legacy = await legacyGuestPaths(repo);
    if (legacy.length > 0) {
      console.log(
        `the repo still carries ${legacy.join(", ")}; nothing builds from them — rerun with --prune-legacy to remove them`,
      );
    }
  }
  /*
   * A commit is not a deployment: the guest is rebuilt on the next call into
   * it, and a warm stateful facet keeps the build it booted with until it is
   * restarted (`talk` does that after a changed install). Saying so beats a
   * caller assuming the old code is gone.
   */
  console.log(
    "the guest rebuilds on its next call; a warm facet keeps its old build until restarted",
  );
}
