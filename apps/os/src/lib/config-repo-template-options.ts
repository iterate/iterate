import { createServerFn } from "@tanstack/react-start";
import { CONFIG_REPO_TEMPLATE_CATALOG } from "../domains/repos/config-repo-template-catalog.generated.ts";
import { formatConfigRepoTemplateReference } from "./config-repo-template-reference.ts";

/**
 * Every picker choice is a GitHub reference. Previews pin it to their head SHA;
 * deployments without a source SHA use the repository's default branch.
 */
export function configRepoTemplateOptionsForDeployment(sourceRef?: string) {
  return CONFIG_REPO_TEMPLATE_CATALOG.map(({ label, path }) => ({
    label,
    reference: formatConfigRepoTemplateReference({
      owner: "iterate",
      repo: "iterate",
      path,
      ...(sourceRef && { ref: sourceRef }),
    }),
  }));
}

export const getConfigRepoTemplateOptions = createServerFn({ method: "GET" }).handler(
  ({ context }) => configRepoTemplateOptionsForDeployment(context.config.iterateRepoPkgRef),
);
