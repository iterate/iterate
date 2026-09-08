// Point a project's config repo at the voice agent package.
//
// The guest worker is @iterate-com/voice-agent, built by the platform from
// node_modules; a project opts in by naming the package in its config repo's
// package.json. This command writes that one line and prints the commit it
// made. Before the package existed it committed the agent's source files into
// every project; `--prune-legacy` deletes those from a repo that still carries
// them, since nothing builds from them any more.
//
//   doppler run --config preview_3 -- pnpm cli voicelab deploy --project prj_…
//   doppler run --config prd -- pnpm cli voicelab deploy --project iterate --prune-legacy
//   pnpm cli voicelab deploy --project iterate --spec https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@<sha>
import {
  installVoiceAgent,
  legacyGuestPaths,
  removeLegacyGuest,
  type VoiceAgentConfigRepo,
} from "@iterate-com/voice-agent";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { withRpcResult } from "./rpc-ownership.ts";

/** Options for `pnpm cli voicelab deploy`. */
export interface DeployOptions extends VoicelabConnectOptions {
  /** Dependency spec to write. Defaults to the package's main build on pkg.pr.new. */
  spec?: string;
  /** Commit message. */
  message?: string;
  /** Also delete the source files an older deploy committed. */
  pruneLegacy?: boolean;
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

export async function deploy(options: DeployOptions) {
  using itx = await connectProject(options);
  const repo = voiceAgentConfigRepo(itx);
  const install = await installVoiceAgent(repo, {
    spec: options.spec,
    existing: "replace",
    message: options.message,
  });
  console.log(
    install.changed
      ? `committed ${install.commitOid.slice(0, 8)}: package.json depends on ${install.spec}`
      : `no change — package.json already depends on ${install.spec} (${install.commitOid.slice(0, 8)})`,
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
