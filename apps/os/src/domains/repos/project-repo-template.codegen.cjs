const fs = require("node:fs");
const path = require("node:path");

/**
 * Lint-codegen preset (see project-repo-template.generated.ts): regenerates
 * the seeded project repo file map from the real, typechecked template folder
 * at apps/os/project-repo-template. Drift between the folder and the generated
 * map is a fixable `codegen/codegen` lint error.
 */
exports.projectRepoTemplateFiles = ({ meta }) => {
  const templateDir = path.resolve(path.dirname(meta.filename), "../../../project-repo-template");
  const relativePaths = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
  return [
    "export const PROJECT_REPO_INITIAL_FILES: Array<{ content: string; path: string }> = [",
    ...entries.map((entry) => {
      // Template files may themselves contain codegen markers (itx.ts is
      // synced by one). Left verbatim inside this file's generated block they
      // would read as the block's own delimiters, so the marker word is
      // emitted as a unicode escape — same string value, different source
      // text.
      const content = JSON.stringify(entry.content).replaceAll("codegen:", "\\u0063odegen:");
      return `  { path: ${JSON.stringify(entry.path)}, content: ${content} },`;
    }),
    "];",
  ].join("\n");
};
