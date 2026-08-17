const fs = require("node:fs");
const path = require("node:path");

/**
 * Lint-codegen preset (see config-repo-template.generated.ts): regenerates
 * the seeded project repo file map from the real, typechecked template folder
 * at configs/default. Drift between the folder and the generated
 * map is a fixable `codegen/codegen` lint error.
 */
exports.projectRepoTemplateFiles = ({ meta }) => {
  const templateDir = path.resolve(path.dirname(meta.filename), "../../../../../configs/default");
  const relativePaths = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Editor droppings (.DS_Store, swapfiles) must not get seeded into
      // every project repo; the template has no legitimate dotfiles.
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else relativePaths.push(path.relative(templateDir, absolute).split(path.sep).join("/"));
    }
  };
  walk(templateDir);

  const entries = relativePaths.sort().map((relativePath) => ({
    content: fs.readFileSync(path.join(templateDir, relativePath), "utf8"),
    path: relativePath,
  }));
  // Template files may themselves contain codegen markers (sdk.ts is
  // synced by one). Left verbatim inside this file's generated block they
  // would read as the block's own delimiters, so the marker word is
  // emitted as a unicode escape — same string value, different source
  // text.
  const quote = (value) => JSON.stringify(value).replaceAll("codegen:", "\\u0063odegen:");
  return [
    "export const PROJECT_REPO_INITIAL_FILES: Array<{ content: string; path: string }> = [",
    ...entries.flatMap((entry) => {
      // One emitted line per template source line (each segment keeps its
      // trailing \n), so git merges this file exactly when it merges the
      // template folder. A whole file per line meant any two branches
      // touching the same template file conflicted here even though their
      // source edits merged cleanly.
      const segments = entry.content.split(/(?<=\n)/);
      return [
        "  {",
        `    path: ${quote(entry.path)},`,
        "    content:",
        ...segments.map(
          (segment, index) =>
            `      ${quote(segment)}${index === segments.length - 1 ? "," : " +"}`,
        ),
        "  },",
      ];
    }),
    "];",
  ].join("\n");
};

/**
 * Every direct configs/* child is a complete project config repository. Keep
 * the create-project UI's catalog derived from those real directories so a
 * template added on a PR appears in that PR's deployed preview without a
 * second hand-maintained registry.
 */
exports.projectRepoTemplateCatalog = ({ meta }) => {
  const configsDir = path.resolve(path.dirname(meta.filename), "../../../../../configs");
  const templateIds = fs
    .readdirSync(configsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  const invalidId = templateIds.find((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id));
  if (invalidId !== undefined) {
    throw new Error(`config template directory must be lowercase kebab-case: ${invalidId}`);
  }
  const defaultIndex = templateIds.indexOf("default");
  if (defaultIndex === -1) throw new Error("configs/default is missing");
  templateIds.splice(defaultIndex, 1);
  templateIds.unshift("default");

  return [
    "export const CONFIG_REPO_TEMPLATE_CATALOG = [",
    ...templateIds.map((id) => {
      const label = id.charAt(0).toUpperCase() + id.slice(1).replaceAll("-", " ");
      return `  { id: ${JSON.stringify(id)}, label: ${JSON.stringify(label)}, path: ${JSON.stringify(`configs/${id}`)} },`;
    }),
    "] as const;",
  ].join("\n");
};
