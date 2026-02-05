export function getAgentWorkingDirectory(): string {
  return process.env.ITERATE_CUSTOMER_REPO_PATH || process.env.ITERATE_REPO || process.cwd();
}
