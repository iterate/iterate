import { createServerFn } from "@tanstack/react-start";
import { CONFIG_REPO_TEMPLATE_CATALOG } from "../domains/repos/config-repo-template-catalog.generated.ts";
import { formatConfigRepoTemplateReference } from "./config-repo-template-reference.ts";

export type ConfigRepoTemplateOption = {
  label: string;
  reference: string;
};

/**
 * The default template is embedded in the deployed worker. Every alternate is
 * copied from iterate/iterate at the preview head SHA already carried by the
 * deployment; without one (production and local dev), GitHub's default branch
 * remains the source.
 */
export function configRepoTemplateOptionsForDeployment(
  sourceRef?: string,
): ConfigRepoTemplateOption[] {
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
  ({ context }): ConfigRepoTemplateOption[] =>
    configRepoTemplateOptionsForDeployment(context.config.iterateRepoPkgRef),
);
