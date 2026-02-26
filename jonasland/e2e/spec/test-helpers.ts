import { randomUUID } from "node:crypto";
import { test } from "../../../spec/test-helpers.ts";
import {
  type SandboxFixture,
  projectDeployment as createProjectDeployment,
} from "../test-helpers/index.ts";

const sandboxImage = process.env.JONASLAND_SANDBOX_IMAGE || "jonasland-sandbox:local";
export const runE2E = process.env.RUN_JONASLAND_E2E === "true";

export { test };

export async function projectDeployment(params?: { name?: string }): Promise<SandboxFixture> {
  return await createProjectDeployment({
    image: sandboxImage,
    name: params?.name ?? `jonasland-playwright-${randomUUID()}`,
  });
}
