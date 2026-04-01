/** @type {import('eslint-plugin-codegen').Preset} */
module.exports = ({ dependencies: { fs, path } }) => {
  const baseDir = path.join(__dirname, "../jonas");
  const files = fs.globSync("0*/**/*", { cwd: baseDir, exclude: ["node_modules", "web"] });
  const entries = files
    .filter((filename) => filename.endsWith(".ts") || filename.endsWith(".sh"))
    .sort()
    .map((filename) => {
      const filepath = path.join(baseDir, filename);
      const fileContent = fs.readFileSync(filepath, "utf8");
      return [filename, fileContent];
    });
  return (
    "function getFiles() {\n" +
    "  // prettier-ignore\n" +
    "  return " +
    JSON.stringify(Object.fromEntries(entries), null, 2).replaceAll("\n", "\n  ") +
    ";\n" +
    "}"
  );
};
