import { getCustomerRepoPath } from "../trpc/platform.ts";

export function getAgentWorkingDirectory(): string {
  return getCustomerRepoPath() || process.env.ITERATE_REPO || process.cwd();
}
