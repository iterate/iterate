import { os } from "@orpc/server";
import { SeedTunnelPoolInput, seedTunnelPool } from "./seed-cloudflare-tunnel-pool.ts";
import {
  PreviewEnvironmentCreateScriptInput,
  PreviewEnvironmentDestroyScriptInput,
  PreviewEnvironmentEnsureInventoryScriptInput,
  PreviewEnvironmentListScriptInput,
  createPreviewEnvironmentViaOrpc,
  destroyPreviewEnvironmentViaOrpc,
  ensurePreviewInventoryViaOrpc,
  listPreviewEnvironmentsViaOrpc,
} from "./preview-environments.ts";

const previewRouter = os.router({
  create: os
    .input(PreviewEnvironmentCreateScriptInput)
    .meta({
      description: "Create or renew a preview environment lease through the Semaphore API",
    })
    .handler(async ({ input }) => {
      return createPreviewEnvironmentViaOrpc(input);
    }),
  destroy: os
    .input(PreviewEnvironmentDestroyScriptInput)
    .meta({
      description: "Release a preview environment through the Semaphore API",
    })
    .handler(async ({ input }) => {
      return destroyPreviewEnvironmentViaOrpc(input);
    }),
  list: os
    .input(PreviewEnvironmentListScriptInput)
    .meta({
      description: "List preview environments through the Semaphore API",
    })
    .handler(async ({ input }) => {
      return listPreviewEnvironmentsViaOrpc(input);
    }),
  ensureInventory: os
    .input(PreviewEnvironmentEnsureInventoryScriptInput)
    .meta({
      description: "Ensure preview environment inventory exists through the Semaphore API",
    })
    .handler(async ({ input }) => {
      return ensurePreviewInventoryViaOrpc(input);
    }),
});

export const router = os.router({
  "seed-cloudflare-tunnel-pool": os
    .input(SeedTunnelPoolInput)
    .meta({
      description: "Seed Cloudflare tunnel resources into semaphore",
      default: true,
    })
    .handler(async ({ input }) => {
      return await seedTunnelPool(input);
    }),
  preview: previewRouter,
});
