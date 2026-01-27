import { getCustomerRepoPath } from "../trpc/platform.ts";

const FALLBACK_REPO = process.env.ITERATE_REPO || "/home/iterate/src/github.com/iterate/iterate";

export function getAgentWorkingDirectory(): string {
  return getCustomerRepoPath() || FALLBACK_REPO;
}
