// scripts/ci/shadcn-drift.ts — THE VENDORED SHADCN FILES ARE UPSTREAM'S (packages/ui/AGENTS.md): each
// folder that vendors shadcn's base-nova components (packages/ui, core/os) keeps them byte for byte
// as `shadcn add <item> -o` writes them, and customises them at the call site or in a wrapper, never
// in the file. This asks each folder's pinned CLI (its `shadcn` devDependency, reading its own
// components.json) what `add` would write today, from shadcn's live registry:
// its dry run's `--view` prints each file's exact content, and whether it would `skip`, `overwrite`
// or `create` it. The CLI's `skip` means identical after it normalises line endings and trims
// leading and trailing whitespace, so the bytes are compared here too.
//
// `check` (.depot/workflows/shadcn-drift.yml, a pull request that touches a vendored file or the
// pin) fails on any difference and prints the CLI's diff of each file. Either someone edited a
// vendored file, or upstream moved since the last refresh; the fix is the same, `refresh`. It fails
// when it could not ask the registry, with no retry: it is not a required check, and a re-run asks
// again.
// `refresh` overwrites every vendored file with upstream's, and lets the CLI add any dependency a
// new version needs; review the diff before committing it.
//
//   node scripts/ci/shadcn-drift.ts check
//   node scripts/ci/shadcn-drift.ts refresh
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCli } from "trpc-cli";

/** Each folder that vendors shadcn items: where the CLI runs (its components.json), the registry
 *  items it asks `add` for, the files those write (their registry dependencies included: input-group
 *  for command, use-mobile for sidebar), and the stylesheet into which the CLI merges an item's CSS,
 *  of which only whether it would is compared. components.json's `aliases.utils` is the `cn` package
 *  itself, so the CLI rewrites a registry item's `@/lib/utils` import (the AI Elements items still
 *  use one) to `import { cn } from "cn"` and no `utils` item is vendored. */
export const VENDORINGS = [
  {
    dir: "packages/ui",
    items: [
      "alert-dialog",
      "avatar",
      "badge",
      "breadcrumb",
      "button",
      "card",
      "checkbox",
      "command",
      "dialog",
      "dropdown-menu",
      "empty",
      "field",
      "input",
      "label",
      "native-select",
      "select",
      "separator",
      "sheet",
      "sidebar",
      "skeleton",
      "sonner",
      "spinner",
      "table",
      "tabs",
      "textarea",
      "tooltip",
    ],
    componentsDir: "src/components/ui",
    extraFiles: ["src/components/ui/input-group.tsx", "src/hooks/use-mobile.ts"],
    stylesheet: "src/styles/globals.css",
  },
  {
    dir: "core/os",
    items: [
      "avatar",
      "button",
      "checkbox",
      "field",
      "input",
      "label",
      "native-select",
      "separator",
      "spinner",
    ],
    componentsDir: "src/components/ui",
    extraFiles: [],
    stylesheet: "src/styles.css",
  },
];

/** Every vendored file, by its path in the repository. The oxlint and oxfmt ignore lists, the
 *  `rules/` exclusions and the drift check's path filter name the same files (shadcn-drift.test.ts). */
export const VENDORED_FILES = VENDORINGS.flatMap((vendoring) => [
  ...vendoring.items.map((item) => `${vendoring.dir}/${vendoring.componentsDir}/${item}.tsx`),
  ...vendoring.extraFiles.map((file) => `${vendoring.dir}/${file}`),
]).sort();

/** The stylesheets the CLI merges items' CSS into: only whether it would, is compared. */
const STYLESHEETS = VENDORINGS.map((vendoring) => `${vendoring.dir}/${vendoring.stylesheet}`);

/** Each file in the output of `add <items> --dry-run --view src/` run in `dir`, by its path in the
 *  repository: what `add` would do to it and the exact content it would write. The CLI prints a file as
 *  `├ <path> (<action>) <n> lines`, then its lines in a box, each after `│ │ `. Throws when a box
 *  does not hold the line count its header gives. Pure. */
export function parseView(output: string, dir: string) {
  const lines = output.split("\n");
  const files: { path: string; action: string; content: string }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const header = /^├ (\S+) \((\w+)\) (\d+) lines$/.exec(lines[index]!);
    if (!header) continue;
    const [, path, action, count] = header;
    const content: string[] = [];
    // skip the header and the box's `│ ┌───` top; the box ends at `│ └───`
    for (index += 2; index < lines.length && !lines[index]!.startsWith("│ └"); index++)
      content.push(lines[index]!.replace(/^│ │ ?/, ""));
    if (content.length !== Number(count))
      throw new Error(`shadcn --view printed ${content.length} of ${path}'s ${count} lines`);
    files.push({ path: `${dir}/${path}`, action: action!, content: content.join("\n") });
  }
  return files;
}

/** What differs from upstream: each vendored file whose bytes are not what `add` would write, a
 *  file `add` writes that is not on the vendored list, a vendored file it no longer writes, and CSS
 *  it would merge into a stylesheet. `current` reads a file in the repository, or undefined. Pure. */
export function driftOf(
  files: { path: string; action: string; content: string }[],
  current: (path: string) => string | undefined,
) {
  const written = new Set(files.map((file) => file.path));
  return [
    ...files.flatMap((file) => {
      if (STYLESHEETS.includes(file.path))
        return file.action === "skip" ? [] : [`${file.path} (${file.action})`];
      if (!VENDORED_FILES.includes(file.path))
        return [`${file.path} (${file.action}, not on the vendored list)`];
      if (current(file.path) === file.content) return [];
      // the CLI skips a file that differs only in line endings or surrounding whitespace
      return [`${file.path} (${file.action === "skip" ? "whitespace" : file.action})`];
    }),
    ...VENDORED_FILES.filter((path) => !written.has(path)).map(
      (path) => `${path} (upstream no longer writes it)`,
    ),
  ];
}

const repoRoot = resolve(import.meta.dirname, "../..");

/** Runs `vendoring`'s pinned CLI in its folder with `args` after `add <every item>`. */
function shadcnAdd(vendoring: (typeof VENDORINGS)[number], args: string[]) {
  return spawnSync(
    "pnpm",
    ["--dir", vendoring.dir, "exec", "shadcn", "add", ...vendoring.items, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      // the --view output holds every vendored file
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

/** Every file `add` would write in every vendoring, with its content (parseView). Throws with the
 *  CLI's output when it could not print them (the registry is a network call). */
function dryRun() {
  return VENDORINGS.flatMap((vendoring) => {
    // `--view <path>` shows every file whose path contains it, CSS included, with no cap on count
    const run = shadcnAdd(vendoring, ["--dry-run", "--view", "src/"]);
    const output = `${run.stdout}${run.stderr}`;
    if (run.status === 0 && /^└ Run without --dry-run to apply\.$/m.test(output))
      return parseView(output, vendoring.dir);
    throw new Error(
      `could not ask the shadcn registry what \`add\` would write in ${vendoring.dir}: shadcn add --dry-run exited ${run.status}:\n${output}`,
    );
  });
}

function drift() {
  return driftOf(dryRun(), (path) => {
    const file = resolve(repoRoot, path);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  });
}

/** Fails when a vendored file differs from what `shadcn add` writes, printing each diff. */
export async function check() {
  const found = drift();
  if (found.length === 0)
    return console.log(`${VENDORED_FILES.length} vendored files match upstream byte for byte`);
  for (const line of found) {
    console.log(`\n${line}`);
    if (line.endsWith(" (whitespace)")) {
      console.log(
        "Differs from upstream only in line endings or leading or trailing whitespace, which the " +
          "CLI's diff ignores.",
      );
      continue;
    }
    const path = line.split(" ")[0]!;
    const vendoring = VENDORINGS.find((candidate) => path.startsWith(`${candidate.dir}/`))!;
    console.log(
      shadcnAdd(vendoring, ["--dry-run", "--diff", path.slice(vendoring.dir.length + 1)]).stdout,
    );
  }
  throw new Error(
    `${found.length} vendored shadcn file(s) differ from upstream. Refresh with ` +
      "`node scripts/ci/shadcn-drift.ts refresh` and review the diff; never edit one by hand " +
      "(packages/ui/AGENTS.md).",
  );
}

/** Rewrites every vendored file with `shadcn add <every item> -o -y`, folder by folder. */
export function refresh() {
  for (const vendoring of VENDORINGS) {
    const run = shadcnAdd(vendoring, ["-o", "-y"]);
    process.stdout.write(`${run.stdout}${run.stderr}`);
    if (run.status !== 0) throw new Error(`shadcn add in ${vendoring.dir} exited ${run.status}`);
  }
}

void createCli({ ...import.meta, name: "shadcn-drift" }).run();
