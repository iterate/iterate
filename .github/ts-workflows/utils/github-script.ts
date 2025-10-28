import * as recast from "recast";
import { Step } from "@jlarky/gha-ts/workflow-types";

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
export const githubScript = <
  Dependencies extends undefined | Record<string, (variables: GitHubScriptVariables) => unknown>,
>(
  handler: (variables: GitHubScriptVariables) => unknown,
  {
    params = {},
    dependencies,
    ...options
  }: {
    params?: Record<string, unknown>;
    dependencies?: Dependencies;
    "github-token"?: string;
    "result-encoding"?: "string";
  } = {},
): Step => {
  const uglyScript = [
    "github.log = {...console, debug: () => {}}", // info/warn/error logging by default
    "const vars = {github, context, core, glob, io, require}",
    ...Object.entries(params).map(([name, param]) => {
      return `const ${name} = ${JSON.stringify(param)}`;
    }),
    ...Object.entries(dependencies || {}).map(([name, dep]) => {
      return `vars.${name} = (${(dep as Function).toString()})(vars)`;
    }),
    "const __handler = " + handler.toString(), // create a temp function that contextual vars will be passed into
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
  // use recast instead of prettier because it's synchronous
  const ast = recast.parse(script, { sourceFileName: import.meta.filename });
  return recast.prettyPrint(ast, {
    quote: "double",
    tabWidth: 2,
    useTabs: false,
    trailingComma: true,
    objectCurlySpacing: true,
    flowObjectCommas: true,
    arrayBracketSpacing: false,
    arrowParensAlways: true,
  });
};
