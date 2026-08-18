import { describe, expect, it } from "vitest";
import { CONFIG_REPO_TEMPLATE_CATALOG } from "../domains/repos/config-repo-template-catalog.generated.ts";
import { configRepoTemplateOptionsForDeployment } from "./config-repo-template-options.ts";

describe("configRepoTemplateOptionsForDeployment", () => {
  it("pins every template reference to the deployed preview commit", () => {
    const commit = "1".repeat(40);
    const options = configRepoTemplateOptionsForDeployment(commit);

    expect(options).toHaveLength(CONFIG_REPO_TEMPLATE_CATALOG.length);
    for (const template of CONFIG_REPO_TEMPLATE_CATALOG) {
      expect(options.find((option) => option.label === template.label)).toEqual({
        label: template.label,
        reference: `github:iterate/iterate#${commit}&path:${template.path}`,
      });
    }
  });

  it("uses the repository default branch when the deployment has no source ref", () => {
    const options = configRepoTemplateOptionsForDeployment();

    for (const template of CONFIG_REPO_TEMPLATE_CATALOG) {
      expect(options.find((option) => option.label === template.label)?.reference).toBe(
        `github:iterate/iterate#path:${template.path}`,
      );
    }
  });
});
