import * as path from "node:path";
import * as crypto from "node:crypto";
import * as recast from "recast";
import tsParser from "recast/parsers/typescript.js";
import { findUpSync } from "find-up";

export type GitHubScriptVariables = {
  context: typeof import("@actions/github").context;
  github: Pick<
    InstanceType<typeof import("@octokit/rest").Octokit>,
    "rest" | "graphql" | "request"
  >;
  core: typeof import("@actions/core");
  glob: typeof import("@actions/glob");
  io: typeof import("@actions/io");
  require: (id: string) => any;
};

type GithubScriptMeta = string /* filename */ | { filename: string };

type GithubScriptOptions = {
  params?: Record<string, unknown>;
  "github-token"?: string;
  "result-encoding"?: "string";
};

/**
 * Allows defining a strongly-typed function using the various helpers provided by
 * [github-script](https://github.com/actions/github-script). The function will be serialized
 * using `.toString()` so out-of-scope variables won't be usable. It also does some whitespace
 * formatting so that the yaml output is readable. This will modify template strings, so don't
 * use this if your function has whitespace-sensitive templates.
 *
 * Enables non-debug logging by default. If you don't want logging, or want to configure it, just mutate it in your script:
 * @example
 * ```ts
 * github.log = {...console, debug: (message, value) => console.log(message, value.headers)}
 * ```
 */
export const githubScript = (
  /** pass `import.meta` here so we know where the original file is, and can ensure any relative imports work */
  meta: GithubScriptMeta,
  handler: (variables: GitHubScriptVariables) => unknown,
  { params = {}, ...options }: GithubScriptOptions = {},
): import("@jlarky/gha-ts/workflow-types").Step => {
  const sourceFilepath = typeof meta === "string" ? meta : meta.filename;
  const githubDir = findUpSync(".github", { cwd: path.dirname(sourceFilepath), type: "directory" });
  if (!githubDir) throw new Error(`Could not find .github directory from ${sourceFilepath}`);
  const repoRoot = path.dirname(githubDir);
  const relativeSourceFilepath = path.relative(repoRoot, sourceFilepath);

  const importShims: Record<string, string> = {};
  const fnString = handler.toString().replace(/await import\(['"](.+)['"]\)/g, (_, filepath) => {
    const hash = crypto.createHash("md5").update(filepath).digest("hex");
    const slug = `${filepath.replaceAll(/\W/g, "")}-${hash}`;

    const jsPath = `${relativeSourceFilepath}.${slug}-tsx-shim.cjs`;
    const jsCode = filepath.match(/\.[cm]?tsx?$/)
      ? `module.exports.load = () => require("tsx/esm/api").tsImport(${JSON.stringify(filepath)}, __filename);`
      : `module.exports.load = () => import(${JSON.stringify(filepath)})`;

    importShims[filepath] = [
      `// write a shimmed module of ${JSON.stringify(filepath)} that actions/github-script can require (see https://github.com/actions/github-script?tab=readme-ov-file#this-action)`,
      `require('fs').writeFileSync(${JSON.stringify(jsPath)}, ${JSON.stringify(jsCode)});`,
    ].join("\n");

    return `await require(${JSON.stringify(jsPath)} /* <-- shimmed module of ${JSON.stringify(filepath)} that actions/github-script can require */).load()`;
  });
  const uglyScript = [
    "github.log = {...console, debug: () => {}}", // info/warn/error logging by default
    ...Object.values(importShims),
    "const vars = {github, context, core, glob, io, require}",

    ...Object.entries(params).map(([name, param]) => {
      return `const ${name} = ${JSON.stringify(param)}`;
    }),
    "const __handler = " + fnString, // create a temp function that contextual vars will be passed into
    "return __handler(vars)", // call the temp function
  ].filter(Boolean);
  const script = prettyPrint(uglyScript.join(";\n"));
  return {
    ...(handler.name && { name: handler.name, id: handler.name }),
    uses: "actions/github-script@v7",
    with: {
      ...options,
      script,
    },
  };
};

const prettyPrint = (script: string) => {
  try {
    // use recast instead of prettier because it's synchronous and we don't really care all that much about how it looks as long as it's readable
    const ast = recast.parse(script, { parser: tsParser });
    return recast.prettyPrint(ast, {
      quote: "double",
      tabWidth: 2,
      useTabs: false,
      trailingComma: true,
      objectCurlySpacing: true,
      flowObjectCommas: true,
      arrayBracketSpacing: false,
      arrowParensAlways: true,
    }).code;
  } catch (error) {
    throw new Error(
      `Error pretty printing script: ${error instanceof Error ? error.message : String(error)}. Script:\n\n${script}`,
    );
  }
};
