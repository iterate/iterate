import { createWorkerClient } from "./orpc/client.ts";

type ReportStatusInput = Parameters<
  ReturnType<typeof createWorkerClient>["machines"]["reportStatus"]
>[0];

/**
 * Report daemon status to the OS platform.
 * Sending "ready" should trigger the bootstrap flow where the platform sends env vars.
 */
export async function reportStatusToPlatform({
  status = "ready",
}: Partial<ReportStatusInput> = {}) {
  if (!process.env.ITERATE_OS_BASE_URL || !process.env.ITERATE_OS_API_KEY) return;
  const machineId = process.env.ITERATE_MACHINE_ID;
  if (!machineId) {
    console.error("[bootstrap] ITERATE_MACHINE_ID not set, cannot report status");
    return;
  }
  const client = createWorkerClient();

  const result = await client.machines.reportStatus({ machineId, status });
  console.log(`[bootstrap] Successfully reported status ${status} to platform`, result);
}
