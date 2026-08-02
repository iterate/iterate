// Put the voicelab guest worker into a project's config repo.
//
// The bridge is userspace code: `config-repo/voice-agent.ts` in this directory
// is the server side of the voice pipe. It deliberately does not replace the
// project's own worker.ts. Deploying used to be a paste into a REPL, which is how
// a device ends up talking to a worker nobody can point at — so it is a
// command, and it prints the commit it made.
//
//   doppler run --config preview_3 -- pnpm cli voicelab deploy --project prj_…
import fs from "node:fs";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";

/** Options for `pnpm cli voicelab deploy`. */
export interface DeployOptions extends VoicelabConnectOptions {
  /** Worker source to commit. Defaults to this directory's config-repo/voice-agent.ts. */
  file?: string;
  /** Commit message. */
  message?: string;
}

interface ConfigRepo {
  readFile(input: { path: string }): Promise<{ content?: string } | string | null>;
  commitFiles(input: {
    changes: { path: string; content: string }[];
    message: string;
  }): Promise<{ commitOid: string; changedPaths: string[]; noChanges: boolean }>;
}

export async function deploy(options: DeployOptions) {
  const file = options.file ?? new URL("./config-repo/voice-agent.ts", import.meta.url).pathname;
  const content = fs.readFileSync(file, "utf8");
  using itx = await connectProject(options);
  const repo = (itx as unknown as { repo: ConfigRepo }).repo;

  const result = await repo.commitFiles({
    changes: [{ content, path: "voice-agent.ts" }],
    message: options.message ?? "voicelab: deploy voice-agent.ts",
  });
  console.log(
    result.noChanges
      ? `no change — the project already runs this worker (${result.commitOid.slice(0, 8)})`
      : `committed ${result.commitOid.slice(0, 8)}: ${result.changedPaths.join(", ")}`,
  );
  /*
   * A commit is not a deployment: the worker is rebuilt on the next call
   * into it. Saying so beats a caller assuming the old code is gone —
   * two bridges answering one turn is a failure this lab has already had.
   */
  console.log(`${content.length} bytes from ${file}`);
}
