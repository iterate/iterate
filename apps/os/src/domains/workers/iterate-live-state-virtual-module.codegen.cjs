const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.iterateLiveStateVirtualModule = ({ meta }) => {
  const script = path.resolve(
    path.dirname(meta.filename),
    "./iterate-live-state-virtual-module.build.mjs",
  );
  const code = execFileSync(process.execPath, [script], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return `export const ITERATE_LIVE_STATE_VIRTUAL_MODULE = ${JSON.stringify(code)};`;
};
