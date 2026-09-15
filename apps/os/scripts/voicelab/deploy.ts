// Point a project's config repo at the voice agent package.
//
// The guest worker is @iterate-com/voice-agent: a project's config repo
// declares the package and re-exports the agent from a three-line
// voice-agent.ts, which the platform builds like any file in the repo. This
// command writes those lines and prewarms the pinned worker with its health
// RPC. Before the package existed it committed the source into every project;
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
  type VoiceAgentConfigRepo,
  type VoiceAgentEntrypointRef,
  type VoiceAgentRpc,
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

type VoiceEntrypointPrewarmProject = {
  workers: {
    get(ref: VoiceAgentEntrypointRef): Pick<VoiceAgentRpc, "health"> & Disposable;
  };
};

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
      ? `committed ${install.commitOid.slice(0, 8)} (${install.changedPaths.join(", ")}): the repo names ${install.spec}`
      : `no change — the repo already names ${install.spec} (${install.commitOid.slice(0, 8)})`,
  );
  let prewarmEntrypointRef = install.entrypointRef;
  if (options.pruneLegacy === true) {
    const removed = await removeLegacyGuest(repo);
    console.log(
      removed === null
        ? "no committed copy of the agent to remove"
        : `committed ${removed.commitOid.slice(0, 8)}: removed ${removed.paths.join(", ")}`,
    );
    if (removed) {
      // Pruning creates a later config-repo commit. Prewarm that exact installed
      // snapshot, rather than the otherwise equivalent commit returned by install.
      prewarmEntrypointRef = {
        ...install.entrypointRef,
        props: { voiceAgentSourceCommitOid: removed.commitOid },
        source: {
          createWorker: {
            ...install.entrypointRef.source.createWorker,
            files: {
              ...install.entrypointRef.source.createWorker.files,
              ref: { commitOid: removed.commitOid },
            },
          },
        },
      };
    }
  } else {
    const legacy = await legacyGuestPaths(repo);
    if (legacy.length > 0) {
      console.log(
        `the repo still carries ${legacy.join(", ")}; nothing builds from them — rerun with --prune-legacy to remove them`,
      );
    }
  }

  const prewarmCommitOid =
    prewarmEntrypointRef.props?.voiceAgentSourceCommitOid ?? install.commitOid;
  console.log(
    `installed voice agent ${prewarmCommitOid.slice(0, 8)}; prewarming its pinned worker`,
  );
  const prewarmStartedAt = Date.now();
  try {
    // Safe: the generated Project exposes workers.get; the installed guest
    // implements VoiceAgentRpc. Keep its capability within this call.
    using worker = (itx as unknown as VoiceEntrypointPrewarmProject).workers.get(
      prewarmEntrypointRef,
    );
    await withRpcResult(worker.health(), (health) => {
      if (health.ok !== true) throw new Error("voice worker health did not report success");
      console.log(
        `prewarmed voice agent ${prewarmCommitOid.slice(0, 8)} in ${Date.now() - prewarmStartedAt}ms (build ${health.buildCacheKey})`,
      );
    });
  } catch (error) {
    throw new Error(
      `voice agent install at ${prewarmCommitOid} succeeded, but prewarming its pinned worker failed; rerun voicelab deploy to retry the cache warmup`,
      { cause: error },
    );
  }
}
