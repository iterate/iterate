import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { unzipSync } from "fflate";
import { z } from "zod";

import { DEPOT_ORG, depotCiApi } from "@iterate-com/shared/depot-api";
import { dopplerSecret } from "../lib/env-context.ts";
import { githubRepository } from "./github.ts";

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

/** Depot's CI API with the organization token (Doppler _shared/preview) bound: how every script
 *  reads Depot. */
export function depotApi(): DepotApi {
  const token = dopplerSecret("_shared", "preview", "DEPOT_CI_TELEMETRY_TOKEN");
  return (method, body) => depotCiApi(method, body, token);
}

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
 * This repository's workflows (github.ts getRepo) named `name` (its `name:`) that one of `triggers`
 * started and that settled, finished or failed, created after `after`, oldest first. A cancelled
 * one is left out: Depot cancels a queued push that a newer one replaced, and a person cancels by
 * hand. It reads the newest 50 of the name, dispatches included: ListWorkflows has no paging
 * (https://github.com/depot/cli/blob/main/proto/depot/ci/v1/ci.proto).
 */
export async function settledWorkflows(
  depot: DepotApi,
  input: { name: string; triggers: string[]; after?: string },
) {
  const { workflows } = ListedWorkflows.parse(
    await depot("ListWorkflows", {
      repo: githubRepository(),
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

/** This repository's workflows named `name` (its `name:`) still in progress, queued or running,
 *  whatever started them, oldest first. The newest 50 of the name, as settledWorkflows reads. */
export async function workflowsInProgress(depot: DepotApi, input: { name: string }) {
  const { workflows } = ListedWorkflows.parse(
    await depot("ListWorkflows", {
      repo: githubRepository(),
      name: input.name,
      status: ["queued", "running"],
      pageSize: 50,
    }),
  );
  return workflows.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const ArtifactPage = z.object({
  artifacts: z
    .array(z.object({ artifactId: z.string(), name: z.string(), createdAt: z.iso.datetime() }))
    .default([]),
});

/** The files of the first artifact `workflow` uploaded whose name `name` matches, by path, or
 *  undefined when it uploaded none. One page: a workflow uploads about eight per execution. */
export async function workflowArtifact(
  depot: DepotApi,
  workflow: { runId: string; workflowId: string },
  name: (artifactName: string) => boolean,
) {
  const { artifacts } = ArtifactPage.parse(
    await depot("ListArtifacts", { ...workflow, pageSize: 500 }),
  );
  const artifact = artifacts
    .filter((candidate) => name(candidate.name))
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!artifact) return undefined;
  const { url } = z
    .object({ url: z.url() })
    .parse(await depot("GetArtifactDownloadURL", { artifactId: artifact.artifactId }));
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${artifact.name} download returned HTTP ${response.status}`);
  return unzipSync(new Uint8Array(await response.arrayBuffer()));
}

/**
 * `file` inside the newest `artifact` a running, finished or failed run of this repository's
 * `workflow` (its `name:`) uploaded, as text — how a job hands its state to its next run (the
 * health job's memory) — or undefined when none of its last 20 runs kept one. A failed run counts:
 * a job that keeps its state before it fails still handed it on. A running one counts too: a state it kept is its first
 * execution's, so a re-run's job reads that instead of the state of the run before it, and judges
 * nothing twice (a job that keeps state runs after the runs before it have ended: the Health
 * workflow's runs one at a time, Main OS e2e's page jobs in turn).
 */
export async function newestArtifactFile(
  depot: DepotApi,
  input: { workflow: string; artifact: string; file: string },
) {
  const { workflows } = ListedWorkflows.parse(
    await depot("ListWorkflows", {
      repo: githubRepository(),
      name: input.workflow,
      status: ["running", "finished", "failed"],
      pageSize: 20,
    }),
  );
  for (const workflow of workflows.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const files = await workflowArtifact(depot, workflow, (name) => name === input.artifact);
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
