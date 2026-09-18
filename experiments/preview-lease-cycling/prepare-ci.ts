// EXPERIMENT ONLY: prepare off the CI critical path, recording its real cost separately.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createSemaphoreClient } from "../../apps/semaphore/src/contract.ts";
import { semaphoreEnvs } from "../../envs.ts";
import { createSemaphoreTokenProvider } from "../../scripts/auth/semaphore-token.ts";
import { Experiment } from "./experiment.ts";

const [id, candidates] = process.argv.slice(2);
const startedAt = Date.now();
const experiment = await Experiment.create(id);
const slug = await experiment.acquire(candidates.split(","));
await experiment.restParked(slug);
const state = await experiment.owned(slug);
assert.equal(state.priorCleanup?.kind, "parked");
const semaphore = createSemaphoreClient({
  baseURL: semaphoreEnvs.prd.baseUrl,
  apiKey: createSemaphoreTokenProvider({
    baseUrl: semaphoreEnvs.prd.baseUrl,
    email: "lease-cycling-experiment@iterate.com",
  }),
}).resources;
const identity = { type: "environment-config-lease", slug };
const released = await semaphore.release({ ...identity, leaseId: state.lease.leaseId });
assert(released.released);
const resource = await semaphore.find(identity);
assert(resource?.lastReleasedAt);
state.stage = "released";
state.releasedAt = resource.lastReleasedAt;
await experiment.save(slug, state);
const receipt = { slug, parkedAt: state.priorCleanup.completedAt, releasedAt: state.releasedAt };
await writeFile(`${experiment.directory}/ci-receipt.json`, JSON.stringify(receipt));
await experiment.record("prepared-for-ci", { receipt, preparationMs: Date.now() - startedAt });
