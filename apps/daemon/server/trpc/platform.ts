/**
 * Get the path to the customer repository.
 * Set by the OS via tool.writeFile to ~/.iterate/.env (ITERATE_CUSTOMER_REPO_PATH).
 */
export async function getCustomerRepoPath(): Promise<string> {
  if (!process.env.ITERATE_CUSTOMER_REPO_PATH) {
    throw new Error("ITERATE_CUSTOMER_REPO_PATH is not set. The OS has not pushed setup data yet.");
  }
  return process.env.ITERATE_CUSTOMER_REPO_PATH;
}
