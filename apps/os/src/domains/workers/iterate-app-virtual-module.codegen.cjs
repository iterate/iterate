const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.iterateAppVirtualModule = ({ meta }) => {
  const script = path.resolve(
    path.dirname(meta.filename),
    "./iterate-app-virtual-module.build.mjs",
  );
  const code = execFileSync(process.execPath, [script], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return `export const ITERATE_APP_VIRTUAL_MODULE = ${JSON.stringify(code)};`;
};
