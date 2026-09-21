// Trimmed workerd bundle of @opencode/sdk/workerd: packages opencode never
// reaches in this deployment (other providers' SDKs, npm install machinery,
// telemetry exporters, native-module shims) are replaced by a CommonJS Proxy
// stub, so named imports still compile and only fail if actually called.
import * as esbuild from "esbuild";

const STUBBED = [
  "@opentelemetry/otlp-transformer",
  "@opentelemetry/sdk-metrics",
  "@opentelemetry/sdk-trace-base",
  "@modelcontextprotocol/client",
  "openai",
  "@npmcli/arborist",
  "@npmcli/config",
  "@smithy/core",
  "@aws-sdk/core",
  "@aws-sdk/nested-clients",
  "venice-ai-sdk-provider",
  "gitlab-ai-provider",
  "iconv-lite",
  "google-auth-library",
  "ws",
  "@anthropic-ai/sdk",
  "web-tree-sitter",
  "@silvia-odwyer/photon-node",
  "@sigstore/protobuf-specs",
  "@sigstore/core",
  "@sigstore/verify",
  "@sigstore/sign",
  "@tufjs/models",
  "pacote",
  "tar",
  "postcss-selector-parser",
  "@ai-sdk/gateway",
  "msgpackr",
];

const filter = new RegExp(`^(${STUBBED.map((p) => p.replace(/[/@.-]/g, "\\$&")).join("|")})(/|$)`);

const stubPlugin = {
  name: "stub-unused-packages",
  setup(build) {
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      loader: "js",
      contents: `const stub = new Proxy(function stub() {}, {
        get: (target, prop) => (prop === "then" || prop === "__esModule" ? undefined : stub),
        apply: () => stub,
        construct: () => stub,
      });
      module.exports = stub;`,
    }));
  },
};

const outdir = process.argv[2] || "opencode";
const result = await esbuild.build({
  entryPoints: ["entry.ts"],
  bundle: true,
  splitting: true,
  minify: true,
  format: "esm",
  platform: "node",
  mainFields: ["module", "main"],
  conditions: ["workerd"],
  external: ["cloudflare:*"],
  banner: {
    js: 'import { createRequire as __iterateCreateRequire } from "node:module"; const require = __iterateCreateRequire("/opencode-workerd.js");',
  },
  outdir,
  metafile: true,
  plugins: [stubPlugin],
  logLimit: 0,
});
const total = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(
  `${outdir}: ${Object.keys(result.metafile.outputs).length} files, ${(total / 1048576).toFixed(1)}MB, warnings ${result.warnings.length}`,
);
