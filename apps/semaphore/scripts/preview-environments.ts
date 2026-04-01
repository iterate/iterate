import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import {
  PreviewEnvironmentCreateInput,
  PreviewEnvironmentDestroyInput,
  PreviewEnvironmentEnsureInventoryInput,
  PreviewEnvironmentListInput,
  createSemaphoreClient,
} from "@iterate-com/semaphore-contract";
import { z } from "zod";
import { AppConfig } from "../src/app.ts";

const DEFAULT_SEMAPHORE_BASE_URL = "https://semaphore.iterate.com";

const PreviewEnvironmentBaseInput = z.object({
  semaphoreBaseUrl: z.string().trim().url().optional(),
});

export const PreviewEnvironmentCreateScriptInput = PreviewEnvironmentCreateInput.extend({
  semaphoreBaseUrl: PreviewEnvironmentBaseInput.shape.semaphoreBaseUrl,
});

export const PreviewEnvironmentDestroyScriptInput = PreviewEnvironmentDestroyInput.extend({
  semaphoreBaseUrl: PreviewEnvironmentBaseInput.shape.semaphoreBaseUrl,
});

export const PreviewEnvironmentListScriptInput = PreviewEnvironmentListInput.extend({
  semaphoreBaseUrl: PreviewEnvironmentBaseInput.shape.semaphoreBaseUrl,
}).default({});

export const PreviewEnvironmentEnsureInventoryScriptInput = z
  .object({
    slotsPerApp: z.coerce.number().int().positive().max(100).optional(),
    semaphoreBaseUrl: PreviewEnvironmentBaseInput.shape.semaphoreBaseUrl,
  })
  .default({});

function resolveSemaphoreBaseUrl(semaphoreBaseUrl?: string) {
  return (semaphoreBaseUrl ?? process.env.SEMAPHORE_BASE_URL ?? DEFAULT_SEMAPHORE_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
}

function createPreviewSemaphoreClient(semaphoreBaseUrl?: string) {
  const config = parseAppConfigFromEnv({
    configSchema: AppConfig,
    prefix: "APP_CONFIG_",
    env: process.env as Record<string, unknown>,
  });

  return createSemaphoreClient({
    apiKey: config.sharedApiSecret.exposeSecret(),
    baseURL: resolveSemaphoreBaseUrl(semaphoreBaseUrl),
  });
}

export async function createPreviewEnvironmentViaOrpc(rawInput: unknown) {
  const input = PreviewEnvironmentCreateScriptInput.parse(rawInput);
  const semaphore = createPreviewSemaphoreClient(input.semaphoreBaseUrl);

  return semaphore.preview.create({
    previewEnvironmentAppSlug: input.previewEnvironmentAppSlug,
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    pullRequestHeadRefName: input.pullRequestHeadRefName,
    pullRequestHeadSha: input.pullRequestHeadSha,
    workflowRunUrl: input.workflowRunUrl,
    leaseMs: input.leaseMs,
    waitMs: input.waitMs,
    previewEnvironmentIdentifier: input.previewEnvironmentIdentifier,
  });
}

export async function destroyPreviewEnvironmentViaOrpc(rawInput: unknown) {
  const input = PreviewEnvironmentDestroyScriptInput.parse(rawInput);
  const semaphore = createPreviewSemaphoreClient(input.semaphoreBaseUrl);

  return semaphore.preview.destroy({
    previewEnvironmentIdentifier: input.previewEnvironmentIdentifier,
    previewEnvironmentSemaphoreLeaseId: input.previewEnvironmentSemaphoreLeaseId,
    destroyReason: input.destroyReason,
  });
}

export async function listPreviewEnvironmentsViaOrpc(rawInput: unknown) {
  const input = PreviewEnvironmentListScriptInput.parse(rawInput);
  const semaphore = createPreviewSemaphoreClient(input.semaphoreBaseUrl);

  return semaphore.preview.list({
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    previewEnvironmentAppSlug: input.previewEnvironmentAppSlug,
    expiredOnly: input.expiredOnly,
  });
}

export async function ensurePreviewInventoryViaOrpc(rawInput: unknown) {
  const input = PreviewEnvironmentEnsureInventoryScriptInput.parse(rawInput);
  const semaphore = createPreviewSemaphoreClient(input.semaphoreBaseUrl);

  return semaphore.preview.ensureInventory({
    slotsPerApp: input.slotsPerApp,
  });
}
