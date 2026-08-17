// The config repository template catalog, generated from every direct child
// of configs/. Edit those folders, then run `pnpm lint:fix`; drift is a fixable
// codegen/codegen lint error.
// codegen:start {preset: custom, source: ./config-repo-template.codegen.cjs, export: projectRepoTemplateCatalog}
export const CONFIG_REPO_TEMPLATE_CATALOG = [
  { id: "default", label: "Default", path: "configs/default" },
  { id: "codemode-tag", label: "Codemode tag", path: "configs/codemode-tag" },
  { id: "with-voice", label: "With voice", path: "configs/with-voice" },
] as const;
// codegen:end
