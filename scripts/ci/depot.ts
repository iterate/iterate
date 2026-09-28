import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { DEPOT_ORG } from "@iterate-com/shared/depot-api";

/** `operation` over `inputs`, at most `concurrency` at a time, outputs in input order: how the
 *  telemetry sync and PR time to green fan out their per-run Depot calls, and the flake dashboard
 *  its R2 reads. */
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

/** A workflow's page on Depot. */
export function depotWorkflowUrl(workflowId: string) {
  return `https://depot.dev/orgs/${DEPOT_ORG}/workflows/${workflowId}`;
}

/** One Depot CI API call with the organization token bound: `@iterate-com/shared/depot-api`
 *  `depotCiApi` as the scripts take it. */
export type DepotApi = (method: string, body: object) => Promise<unknown>;

// Connect's JSON encoding omits empty strings and lists, so an unset field is absent rather than "":
// https://protobuf.dev/programming-guides/json/ ("default values are omitted").
const ListedWorkflows = z.object({
  workflows: z
    .array(
      z.object({
        workflowId: z.string(),
        runId: z.string(),
        status: z.string(),
        trigger: z.string().default(""),
        sha: z.string().default(""),
        createdAt: z.iso.datetime(),
      }),
    )
    .default([]),
});
export type SettledWorkflow = z.infer<typeof ListedWorkflows>["workflows"][number];

/**
 * The workflows named `name` (its `name:`) that one of `triggers` started and that settled, finished
 * or failed, created after `after`, oldest first. A cancelled one is left out: Depot cancels a
 * queued push that a newer one replaced, and a person cancels by hand. It reads the newest 50 of the
 * name, dispatches included: ListWorkflows has no paging
 * (https://github.com/depot/cli/blob/main/proto/depot/ci/v1/ci.proto).
 */
export async function settledWorkflows(
  depot: DepotApi,
  input: { name: string; triggers: string[]; after?: string },
) {
  const { workflows } = ListedWorkflows.parse(
    await depot("ListWorkflows", {
      repo: "iterate/iterate",
      name: input.name,
      status: ["finished", "failed"],
      pageSize: 50,
    }),
  );
  return workflows
    .filter(
      (workflow) =>
        input.triggers.includes(workflow.trigger) &&
        (!input.after || workflow.createdAt > input.after),
    )
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const ArtifactPage = z.object({
  artifacts: z
    .array(z.object({ artifactId: z.string(), name: z.string(), createdAt: z.iso.datetime() }))
    .default([]),
});

/** The files of the first artifact `workflow` uploaded whose name `name` matches, by path, or
 *  undefined when it uploaded none — or of the newest, `which: "newest"`: a job re-run uploads
 *  again under the same name. One page: a workflow uploads about eight per execution. */
export async function workflowArtifact(
  depot: DepotApi,
  workflow: { runId: string; workflowId: string },
  name: (artifactName: string) => boolean,
  which: "first" | "newest",
) {
  const { artifacts } = ArtifactPage.parse(
    await depot("ListArtifacts", { ...workflow, pageSize: 500 }),
  );
  const matching = artifacts
    .filter((candidate) => name(candidate.name))
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const artifact = which === "first" ? matching[0] : matching.at(-1);
  if (!artifact) return undefined;
  const { url } = z
    .object({ url: z.url() })
    .parse(await depot("GetArtifactDownloadURL", { artifactId: artifact.artifactId }));
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${artifact.name} download returned HTTP ${response.status}`);
  return unzip(new Uint8Array(await response.arrayBuffer()));
}

/**
 * `file` inside the newest `artifact` a running, finished or failed run of `workflow` (its `name:`)
 * uploaded, as text — how a job hands its state to its next run (the health job's memory) — or
 * undefined when none of its last 20 runs kept one. A failed run counts: a job that keeps its state
 * before it fails still handed it on. A running one counts too: a state it kept is its first
 * execution's, so a re-run's job reads that instead of the state of the run before it, and judges
 * nothing twice (the workflows that keep state run one at a time).
 */
export async function newestArtifactFile(
  depot: DepotApi,
  input: { workflow: string; artifact: string; file: string },
) {
  const { workflows } = ListedWorkflows.parse(
    await depot("ListWorkflows", {
      repo: "iterate/iterate",
      name: input.workflow,
      status: ["running", "finished", "failed"],
      pageSize: 20,
    }),
  );
  for (const workflow of workflows.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const files = await workflowArtifact(
      depot,
      workflow,
      (name) => name === input.artifact,
      "first",
    );
    if (!files) continue;
    const bytes = files[input.file];
    if (!bytes)
      throw new Error(`${input.artifact} of ${workflow.workflowId} holds no ${input.file}`);
    return new TextDecoder().decode(bytes);
  }
  return undefined;
}

/** newestArtifactFile's text, written to `out`: a scheduled job's `previous-state` step, which
 *  hands its last run's state to this one. Nothing is written when none of the last 20 runs kept
 *  one. What it did, for the log. */
export async function saveNewestArtifactFile(
  depot: DepotApi,
  input: { workflow: string; artifact: string; file: string; out: string },
) {
  const text = await newestArtifactFile(depot, input);
  if (!text) return "no previous state";
  await mkdir(dirname(input.out), { recursive: true });
  await writeFile(input.out, text);
  return `previous state: ${text.length} bytes`;
}

/**
 * Minimal zip reader on the runtime's own DecompressionStream — deliberately
 * not a dependency. The format surface is narrow by construction: one
 * producer (actions/upload-artifact, whose zips Depot stores), read via the
 * central directory (sizes come from there, so streaming-writer data
 * descriptors don't matter). No zip64: the artifacts CI reads, a job's test
 * results at the most (about 1 MB for a specs job, measured 2026-09-28), are far
 * under its 4 GiB and 65,535 entries. Anything unexpected throws.
 */
async function unzip(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
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
