import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  PLATFORM_FAILURE_DELAYS_MS,
  retryPlatformFailures,
} from "@iterate-com/shared/platform-retry";

/** Iterate's Depot organization, which runs every workflow in .depot/workflows (docs/depot-ci.md). */
export const DEPOT_ORG = "0p91s0lz49";

/** `operation` over `inputs`, at most `concurrency` at a time, outputs in input order: how the
 *  telemetry sync fans out its per-run Depot calls, and the flake dashboard its R2 reads. */
export async function mapConcurrent<Input, Output>(
  inputs: Input[],
  concurrency: number,
  operation: (input: Input) => Promise<Output>,
) {
  const outputs = new Array<Output>(inputs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= inputs.length) return;
        outputs[index] = await operation(inputs[index]!);
      }
    }),
  );
  return outputs;
}

/**
 * One call to Depot's CI API, the Connect JSON protocol the Depot CLI itself speaks. The methods and
 * their fields are in https://github.com/depot/cli/blob/main/proto/depot/ci/v1/ci.proto (JSON uses
 * the camelCase field names). `token` is an organization API token (`DEPOT_CI_TELEMETRY_TOKEN`).
 *
 * A read (`Get…`, `List…`, the only methods CI calls) that Depot answers with a 5xx, or whose
 * connection fails, is asked again after each of `delaysMs`, with a `depot.platform-failure-retry`
 * warn per repeat (`retryPlatformFailures`). A 4xx is an answer about the request and fails at
 * once, as does any other method (Connect sends every call as a POST, so only the name says it
 * changes nothing). A single 500 on GetJobAttemptLogs is enough to fail a trace job without the
 * repeat.
 */
export async function depotCiApi(
  method: string,
  body: object,
  token: string,
  options: { fetch?: typeof fetch; delaysMs?: readonly number[] } = {},
): Promise<unknown> {
  const { fetch: fetchImpl = fetch, delaysMs = PLATFORM_FAILURE_DELAYS_MS } = options;
  return retryPlatformFailures(
    async () => {
      const response = await fetchImpl(`https://api.depot.dev/depot.ci.v1.CIService/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-depot-org": DEPOT_ORG,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return await response.json();
      await response.body?.cancel();
      throw Object.assign(new Error(`Depot ${method} returned HTTP ${response.status}`), {
        status: response.status,
      });
    },
    {
      event: "depot.platform-failure-retry",
      delaysMs: /^(Get|List)[A-Z]/.test(method) ? delaysMs : [],
      platformFailure: (error) => {
        // fetch rejects with a TypeError when the connection fails; a timeout or an abort is not
        // Depot's answer and is thrown as it is.
        if (error instanceof TypeError)
          return { method, status: "network", message: error.message };
        const { status = 0, message } = error as { status?: number; message?: string };
        return status >= 500 ? { method, status, message } : undefined;
      },
    },
  );
}

/** The Depot CLI (`depot <args> --org <iterate>`). CI passes the organization token as DEPOT_TOKEN
 *  (Doppler _shared/preview `DEPOT_CI_TELEMETRY_TOKEN`); a laptop uses the CLI's own login. */
export async function depotCli(args: string[]) {
  return promisify(execFileCallback)("depot", [...args, "--org", DEPOT_ORG], {
    maxBuffer: 50 * 1024 * 1024,
  });
}

/** The Depot CLI's `--output json` answer. */
export async function depotCliJson<T>(args: string[]): Promise<T> {
  const { stdout } = await depotCli([...args, "--output", "json"]);
  return JSON.parse(stdout) as T;
}

/**
 * `file` inside the newest `artifact` a finished or failed run of `workflow` (its `name:`) uploaded,
 * as text — how a scheduled job hands its state to its next run (the latency guard's baseline) —
 * or undefined when none of its last 20 runs kept one. A failed run
 * counts: a job that keeps its state before it fails still handed it on.
 */
export async function newestArtifactFile(input: {
  repository: string;
  workflow: string;
  artifact: string;
  file: string;
}) {
  const runs = await depotCliJson<{ run_id: string; workflow_id: string; created_at: string }[]>([
    "ci",
    "workflow",
    "list",
    "--repo",
    input.repository,
    "--name",
    input.workflow,
    "--status",
    "finished",
    "--status",
    "failed",
    "-n",
    "20",
  ]);
  for (const run of runs.toSorted((a, b) => b.created_at.localeCompare(a.created_at))) {
    const { artifacts } = await depotCliJson<{
      artifacts: { artifact_id: string; workflow_id: string; name: string }[];
    }>(["ci", "artifacts", "list", run.run_id]);
    const artifact = artifacts.find(
      (candidate) => candidate.workflow_id === run.workflow_id && candidate.name === input.artifact,
    );
    if (!artifact) continue;
    const directory = await mkdtemp(join(tmpdir(), `${input.artifact}-`));
    try {
      const zip = join(directory, "artifact.zip");
      await depotCli(["ci", "artifacts", "download", artifact.artifact_id, "--output-file", zip]);
      const { [input.file]: bytes } = await unzip(new Uint8Array(await readFile(zip)));
      if (!bytes)
        throw new Error(`${input.artifact} ${artifact.artifact_id} holds no ${input.file}`);
      return new TextDecoder().decode(bytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return undefined;
}

/** newestArtifactFile's text in this repository, written to `out`: a scheduled guard's
 *  `previous-state` step, which hands its last run's state to this one. Nothing is written when none
 *  of the last 20 runs kept one. What it did, for the log. */
export async function saveNewestArtifactFile(input: {
  workflow: string;
  artifact: string;
  file: string;
  out: string;
}) {
  const text = await newestArtifactFile({
    repository: process.env.GITHUB_REPOSITORY || "iterate/iterate",
    ...input,
  });
  if (!text) return "no previous state";
  await mkdir(dirname(input.out), { recursive: true });
  await writeFile(input.out, text);
  return `previous state: ${text.length} bytes`;
}

/**
 * Minimal zip reader on the runtime's own DecompressionStream — deliberately
 * not a dependency. The format surface is narrow by construction: one
 * producer (GitHub's artifact service), a 5MB size cap upstream, and reading
 * via the central directory (sizes come from there, so streaming-writer data
 * descriptors don't matter). No zip64 — impossible under the size cap — and
 * anything unexpected throws, which ingestion treats as a logged drop.
 */
export async function unzip(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record sits at the tail, behind an optional
  // comment (max 64KB): scan backwards for its signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  const entryCount = view.getUint16(eocd + 10, true);
  const files: Record<string, Uint8Array> = {};
  let offset = view.getUint32(eocd + 16, true);
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("corrupt zip: bad central directory entry signature");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    // The local header's name/extra lengths can differ from the central
    // directory's, so the data offset comes from the local header itself.
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    // slice (not subarray): a copy backed by a plain ArrayBuffer, which both
    // the DOM and Workers Response typings accept without assertions.
    const data = bytes.slice(dataStart, dataStart + compressedSize);
    if (method === 0) {
      files[name] = data;
    } else if (method === 8) {
      const inflated = new Response(data).body!.pipeThrough(new DecompressionStream("deflate-raw"));
      files[name] = new Uint8Array(await new Response(inflated).arrayBuffer());
    } else {
      throw new Error(`unsupported zip compression method ${method} for ${name}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
