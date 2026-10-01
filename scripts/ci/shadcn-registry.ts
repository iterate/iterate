// scripts/ci/shadcn-registry.ts — THE SHADCN REGISTRY (packages/ui/AGENTS.md): an app gets one of
// our rendered components with `shadcn add @iterate/<item>` and keeps its own copy. Copybara copies
// packages/ to github.com/iterate/packages after each deploy, and an app's components.json fetches
// the items from there (`https://raw.githubusercontent.com/iterate/packages/main/packages/ui/r/{name}.json`).
//
// packages/ui/registry.json names each item and its files. `build` works out the rest from the files
// themselves and writes it back: each file's type, the packages the files import (`dependencies`) and
// the items they import through `#/` (`registryDependencies`: shadcn's by name, `button`, and ours as
// `@iterate/<item>`). Then it runs the pinned CLI's `shadcn build`, which writes r/<item>.json with
// each file's content, unchanged. Lint and Typecheck fails when either is not what `build` writes.
//
// `build` throws where an app installing an item would get a file that imports something it does
// not have: a relative import of another item's file (the app's copy of that item may live elsewhere,
// or not exist), a `#/` import of a file that is in no item, or a private `@iterate-com/*` package. A file
// in src/components (shadcn's ui/ aside) or src/lib that no item lists throws too.
//
// `round-trip` (.depot/workflows/shadcn-drift.yml; it needs shadcn's registry for `button` and the
// rest) serves the built r/ locally and asks the CLI's dry run what `shadcn add @iterate/<every item>`
// writes into an app with packages/ui's own components.json. That must be packages/ui's own bytes:
// the CLI rewrites `#/` imports to the app's aliases, which here are packages/ui's.
//
//   node scripts/ci/shadcn-registry.ts build
//   node scripts/ci/shadcn-registry.ts round-trip
import { execFile, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { parseSync } from "oxc-parser";
import { createCli } from "trpc-cli";
import { z } from "zod";
import { parseView } from "./shadcn-drift.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const ui = resolve(repoRoot, "packages/ui");

/** registry.json's hand-written part: each item's name, description and files. `build` derives
 *  the rest, so parsing drops it. */
const Registry = z.object({
  $schema: z.string(),
  name: z.string(),
  homepage: z.string(),
  items: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      files: z.array(z.object({ path: z.string() })),
    }),
  ),
});
type Registry = z.infer<typeof Registry>;

/** Every package an app already has: shadcn's own items leave them out too. */
const ASSUMED_PACKAGES = new Set(["react", "react-dom"]);

/** `registry` with each item's file types, `dependencies` and `registryDependencies` worked out from
 *  `source` (every file under packages/ui/src, by its path in packages/ui, `src/components/…`).
 *  Throws listing every file an app could not install as is (the header). Pure. */
export function withDependencies(registry: Registry, source: Map<string, string>) {
  const problems: string[] = [];
  const itemOf = new Map<string, string>();
  for (const item of registry.items)
    for (const { path } of item.files) {
      if (!source.has(path)) problems.push(`${item.name}: ${path} does not exist`);
      const other = itemOf.get(path);
      if (other) problems.push(`${path} is in both ${other} and ${item.name}`);
      itemOf.set(path, item.name);
    }
  for (const path of source.keys())
    if (belongsInRegistry(path) && !itemOf.has(path))
      problems.push(`${path} is in no item: add it to one in registry.json`);

  const items = registry.items.map((item) => {
    const dependencies = new Set<string>();
    const registryDependencies = new Set<string>();
    for (const { path } of item.files) {
      if (!/\.tsx?$/.test(path) || !source.has(path)) continue;
      for (const specifier of importsOf(path, source.get(path)!)) {
        const found = resolveImport({ path, specifier, item: item.name, source, itemOf });
        if (!found) continue;
        if ("problem" in found) problems.push(`${path}: ${found.problem}`);
        else if ("dependency" in found) dependencies.add(found.dependency);
        else registryDependencies.add(found.registryDependency);
      }
    }
    const files = item.files.map(({ path }) => ({ path, type: fileType(path) }));
    return {
      name: item.name,
      type: files.every((file) => file.type === "registry:lib")
        ? "registry:lib"
        : "registry:component",
      description: item.description,
      ...(dependencies.size > 0 && { dependencies: [...dependencies].sort() }),
      ...(registryDependencies.size > 0 && {
        registryDependencies: [...registryDependencies].sort(),
      }),
      files,
    };
  });
  if (problems.length > 0)
    throw new Error(
      `packages/ui/registry.json: an app installing these items would get files that import what it does not have:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  return { ...registry, items };
}

/** Every file in src/components (but shadcn's own ui/) and src/lib is in some item; tests are not. */
function belongsInRegistry(path: string) {
  return (
    (path.startsWith("src/components/") || path.startsWith("src/lib/")) &&
    !path.startsWith("src/components/ui/") &&
    !/\.test\.tsx?$/.test(path)
  );
}

/** Where `shadcn add` writes the file: the app's lib alias, or its components alias (an svg goes
 *  beside the component that imports it). */
function fileType(path: string) {
  return path.startsWith("src/lib/") ? "registry:lib" : "registry:component";
}

/** Every module a file imports: static, re-exported and dynamic. */
function importsOf(path: string, content: string) {
  const { module, errors } = parseSync(path, content);
  if (errors.length > 0) throw new Error(`${path} does not parse: ${errors[0]!.message}`);
  return [
    ...module.staticImports.map((entry) => entry.moduleRequest.value),
    ...module.staticExports.flatMap((entry) =>
      entry.entries.flatMap((exported) =>
        exported.moduleRequest ? [exported.moduleRequest.value] : [],
      ),
    ),
    ...module.dynamicImports.map(({ moduleRequest }) => {
      const literal = /^(["'])(.*)\1$/.exec(content.slice(moduleRequest.start, moduleRequest.end));
      if (!literal) throw new Error(`${path}: a dynamic import of something other than a string`);
      return literal[2]!;
    }),
  ];
}

/** What one import asks of the app installing `item`: a package, a registry item, or nothing (a
 *  file of the same item, which travels with it, or a package every app has). */
function resolveImport(input: {
  path: string;
  specifier: string;
  item: string;
  source: Map<string, string>;
  itemOf: Map<string, string>;
}): { problem: string } | { dependency: string } | { registryDependency: string } | undefined {
  const { path, specifier, item, source, itemOf } = input;
  if (specifier.startsWith(".")) {
    const target = posix.normalize(posix.join(posix.dirname(path), specifier));
    if (!source.has(target)) return { problem: `${specifier} does not exist` };
    if (itemOf.get(target) === item) return;
    return {
      problem: `${specifier} is ${itemOf.get(target) || "in no item"}'s, not ${item}'s: import it as #/${target.slice("src/".length)}`,
    };
  }
  if (specifier.startsWith("#/")) {
    const target = `src/${specifier.slice("#/".length)}`;
    if (!source.has(target)) return { problem: `${specifier} does not exist` };
    if (target.startsWith("src/components/ui/"))
      return { registryDependency: posix.basename(target).replace(/\.tsx?$/, "") };
    const owner = itemOf.get(target);
    if (!owner)
      return { problem: `${specifier} is in no item, so an app installing ${item} lacks it` };
    if (owner === item) return { problem: `${specifier} is ${item}'s own: import it relatively` };
    return { registryDependency: `@iterate/${owner}` };
  }
  if (specifier.startsWith("@iterate-com/"))
    return {
      problem: `${specifier} is a private workspace package, which an app outside the monorepo cannot install`,
    };
  const name = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0]!;
  if (ASSUMED_PACKAGES.has(name)) return;
  return { dependency: name };
}

/** Each item file (`files`, by repository path) the dry run did not write, or wrote differently
 *  from `current`. The CLI drops a file's leading comment (it returns ts-morph's
 *  `sourceFile.getText()`, which starts at the first statement: shadcn-ui/ui#9206, fixed by the
 *  open shadcn-ui/ui#11920), so that is all a file may lose. shadcn's own items it writes are
 *  shadcn-drift.ts's to check: which "use client" lines they get depends on the batch. Pure. */
export function roundTripProblems(input: {
  files: string[];
  written: { path: string; content: string }[];
  current: (path: string) => string;
}) {
  const written = new Map(input.written.map((file) => [file.path, file.content]));
  return input.files.flatMap((path) => {
    if (!written.has(path)) return [`${path} (not written)`];
    const expected = /\.tsx?$/.test(path)
      ? input.current(path).replace(/^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/, "")
      : input.current(path);
    return written.get(path) === expected ? [] : [`${path} (differs)`];
  });
}

/** Every file under packages/ui/src, by its path in packages/ui. */
function readSource() {
  return new Map(
    readdirSync(join(ui, "src"), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [relative(ui, file), readFileSync(file, "utf8")] as const;
      }),
  );
}

function readRegistry() {
  return Registry.parse(JSON.parse(readFileSync(join(ui, "registry.json"), "utf8")));
}

/** Writes each item's dependencies into registry.json, then r/ with `shadcn build`. */
export async function build() {
  const registry = withDependencies(readRegistry(), readSource());
  writeFileSync(join(ui, "registry.json"), `${JSON.stringify(registry, null, 2)}\n`);
  // r/ holds exactly the items: one removed from registry.json leaves no stale file
  rmSync(join(ui, "r"), { recursive: true, force: true });
  const run = spawnSync("pnpm", ["--dir", "packages/ui", "exec", "shadcn", "build", "-o", "r"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (run.status !== 0) throw new Error(`shadcn build exited ${run.status}`);
  console.log(`packages/ui/r: ${registry.items.length} items`);
}

/** Fails when `shadcn add @iterate/<every item>`, from the built r/, writes anything but packages/ui's
 *  own bytes. */
export async function roundTrip() {
  const server = createServer((request, response) => {
    const name = /^\/([\w-]+\.json)$/.exec(request.url || "")?.[1];
    if (!name) return response.writeHead(404).end();
    try {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(readFileSync(join(ui, "r", name)));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number }; // listening on a TCP port, never a pipe
  const app = mkdtempSync(join(tmpdir(), "shadcn-registry-"));
  try {
    // an app with packages/ui's aliases (package.json's `#/*` imports, components.json), compiler
    // options and stylesheet, fetching @iterate from the local server
    copyFileSync(join(ui, "package.json"), join(app, "package.json"));
    writeFileSync(
      join(app, "tsconfig.json"),
      JSON.stringify({ extends: join(ui, "tsconfig.json") }),
    );
    mkdirSync(join(app, "src/styles"), { recursive: true });
    copyFileSync(join(ui, "src/styles/globals.css"), join(app, "src/styles/globals.css"));
    const config = JSON.parse(readFileSync(join(ui, "components.json"), "utf8"));
    writeFileSync(
      join(app, "components.json"),
      JSON.stringify({
        ...config,
        registries: { "@iterate": `http://127.0.0.1:${port}/{name}.json` },
      }),
    );
    const registry = readRegistry();
    const items = registry.items.map((item) => `@iterate/${item.name}`);
    // async: this process's server answers the CLI's fetches while it runs
    const run = await promisify(execFile)(
      "pnpm",
      [
        "--dir",
        "packages/ui",
        "exec",
        "shadcn",
        "add",
        ...items,
        "--dry-run",
        "--view",
        "src/",
        "--cwd",
        app,
      ],
      { cwd: repoRoot, env: { ...process.env, NO_COLOR: "1" }, maxBuffer: 64 * 1024 * 1024 },
    ).catch((error: { stdout: string; stderr: string; code: number }) => {
      throw new Error(`shadcn add --dry-run exited ${error.code}:\n${error.stdout}${error.stderr}`);
    });
    const output = `${run.stdout}${run.stderr}`;
    if (!/^└ Run without --dry-run to apply\.$/m.test(output))
      throw new Error(`shadcn add --dry-run printed no files:\n${output}`);
    const problems = roundTripProblems({
      files: registry.items.flatMap((item) => item.files.map((file) => `packages/ui/${file.path}`)),
      written: parseView(output, "packages/ui"),
      current: (path) => readFileSync(join(repoRoot, path), "utf8"),
    });
    if (problems.length > 0)
      throw new Error(
        `shadcn add @iterate/<every item> does not write packages/ui's files back:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
      );
    console.log(
      `shadcn add of ${items.length} items writes their files back as packages/ui has them`,
    );
  } finally {
    server.close();
    rmSync(app, { recursive: true, force: true });
  }
}

void createCli({ ...import.meta, name: "shadcn-registry" }).run();
