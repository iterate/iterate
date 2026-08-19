// The config repository template catalog, generated from every direct child
// of configs/. Edit those folders, then run `pnpm lint:fix`; drift is a fixable
// codegen/codegen lint error.
// codegen:start {preset: custom, source: ./config-repo-template.codegen.cjs, export: projectRepoTemplateCatalog}
export const CONFIG_REPO_TEMPLATE_CATALOG = [
  { label: "Default", path: "configs/default" },
  { label: "Codemode tag", path: "configs/codemode-tag" },
  { label: "Voice agent", path: "configs/voice-agent" },
  { label: "With voice", path: "configs/with-voice" },
] as const;
// codegen:end
