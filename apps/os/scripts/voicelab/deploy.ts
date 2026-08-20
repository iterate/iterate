// Put the voicelab guest worker into a project's config repo.
//
// The bridge is userspace code: `configs/voice-agent/voice-agent.ts` at the
// repository root is the server side of the voice pipe. It deliberately does not replace the
// project's own worker.ts. Deploying used to be a paste into a REPL, which is how
// a device ends up talking to a worker nobody can point at — so it is a
// command, and it prints the commit it made.
//
//   doppler run --config preview_3 -- pnpm cli voicelab deploy --project prj_…
import fs from "node:fs";
import path from "node:path";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { withRpcResult } from "./rpc-ownership.ts";

/** Options for `pnpm cli voicelab deploy`. */
export interface DeployOptions extends VoicelabConnectOptions {
  /** Worker source to commit. Defaults to the repo-root configs/voice-agent/voice-agent.ts template. */
  file?: string;
  /** Commit message. */
  message?: string;
}

/** What committing the guest did, for a caller that wants to say so itself. */
export interface InstallResult {
  commitOid: string;
  changed: boolean;
  bytes: number;
  file: string;
  /** Every path committed, entry point first — derived, so worth printing. */
  paths: string[];
}

/**
 * Relative import specifiers, which are the ones that have to travel.
 *
 * Package imports resolve from the platform at build time; a `./x.ts` resolves
 * from the repo, and is `No such module` if it is not in it.
 */
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g;

/**
 * Everything the guest needs, walked from the entry point's own imports.
 *
 * DERIVED, AND IT HAS TO BE. This was a hand-written list of two filenames
 * next to a file that imports three, and the day `speaker.ts` was extracted
 * the deployed worker stopped building entirely — `Failed to resolve
 * './speaker.ts' from voice-agent.ts`, at the project's cold start, hours
 * after a commit that looked fine everywhere it was tested. A second copy of
 * a list the source already contains will drift; the only question is when.
 *
 * The repo is FLAT — every file lands at the root beside the entry point — so
 * a specifier that names a subdirectory or climbs out of one cannot be
 * committed at all, and saying so here beats a `No such module` later.
 */
function voiceAgentSources(
  entryFile: string,
  entryName: string,
): { path: string; content: string }[] {
  const directory = path.dirname(entryFile);
  const files = new Map<string, string>();
  /* The entry lands under the name `voice-agent-ref.ts` asks the platform to
   * build, whatever it is called on disk. */
  const queue: { name: string; readFrom: string }[] = [{ name: entryName, readFrom: entryFile }];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (files.has(next.name)) continue;
    const content = fs.readFileSync(next.readFrom, "utf8");
    files.set(next.name, content);
    for (const match of content.matchAll(RELATIVE_IMPORT)) {
      const specifier = match[1]!;
      const name = specifier.slice(2);
      if (!specifier.startsWith("./") || name.includes("/")) {
        throw new Error(
          `${next.name} imports ${specifier}, but a project's config repo is flat: ` +
            `everything the guest imports must sit beside it.`,
        );
      }
      queue.push({ name, readFrom: path.join(directory, name) });
    }
  }
  return [...files].map(([name, content]) => ({ content, path: name }));
}

interface ConfigRepo {
  readFile(input: { path: string }): Promise<{ content?: string } | string | null>;
  commitFiles(input: {
    changes: { path: string; content: string }[];
    message: string;
  }): Promise<{ commitOid: string; changedPaths: string[]; noChanges: boolean }>;
}

/**
 * Commit the guest worker into an already-connected project's config repo.
 *
 * Separate from the `deploy` command because `talk` needs it too, and for a
 * reason worth stating: `setupVoiceAgent` LIVES IN this file, so the file has
 * to be in the repo before anybody can call it. A talk command that only ran
 * setup would work on the machine that had deployed by hand and fail against
 * a fresh project, which is the whole failure this command exists to end.
 *
 * Committing identical content is a no-op the platform reports, so callers
 * may do this unconditionally.
 */
export async function installVoiceAgent(
  itx: unknown,
  options: { file?: string; message?: string } = {},
): Promise<InstallResult> {
  const entryName = "voice-agent.ts";
  const file =
    options.file ??
    new URL(`../../../../configs/voice-agent/${entryName}`, import.meta.url).pathname;
  const changes = voiceAgentSources(file, entryName);
  const repo = (itx as { repo: ConfigRepo }).repo;
  const result = await withRpcResult(
    repo.commitFiles({
      changes,
      message: options.message ?? `voicelab: deploy ${entryName}`,
    }),
    ({ commitOid, changedPaths, noChanges }) => ({ commitOid, changedPaths, noChanges }),
  );
  return {
    bytes: changes.reduce((total, change) => total + change.content.length, 0),
    changed: !result.noChanges,
    commitOid: result.commitOid,
    file,
    paths: changes.map((change) => change.path),
  };
}

export async function deploy(options: DeployOptions) {
  using itx = await connectProject(options);
  const result = await installVoiceAgent(itx, options);
  console.log(
    result.changed
      ? `committed ${result.commitOid.slice(0, 8)}: ${result.paths.join(", ")}`
      : `no change — the project already runs this worker (${result.commitOid.slice(0, 8)})`,
  );
  /*
   * A commit is not a deployment: the worker is rebuilt on the next call
   * into it. Saying so beats a caller assuming the old code is gone —
   * two bridges answering one turn is a failure this lab has already had.
   */
  console.log(`${String(result.bytes)} bytes from ${result.file}`);
}
