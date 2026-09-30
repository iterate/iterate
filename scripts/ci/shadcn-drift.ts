// scripts/ci/shadcn-drift.ts — THE VENDORED SHADCN FILES ARE UPSTREAM'S (packages/ui/AGENTS.md):
// packages/ui keeps shadcn's base-nova components byte for byte as `shadcn add <item> -o` writes them,
// and customises them at the call site or in a wrapper, never in the file. This asks the pinned CLI
// (packages/ui's `shadcn` devDependency) what `add` would write today, from shadcn's live registry:
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

/** The registry items packages/ui vendors: what `shadcn add` is asked for. Each writes
 *  src/components/<item>.tsx. components.json's `aliases.utils` is the `cn` package itself, so the
 *  CLI rewrites a registry item's `@/lib/utils` import (the AI Elements items still use one) to
 *  `import { cn } from "cn"` and no `utils` item is vendored. */
export const SHADCN_ITEMS = [
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
];

/** The files those items write, their registry dependencies (input-group for command, use-mobile
 *  for sidebar) included. The oxlint and oxfmt ignore lists, the `rules/` exclusions and the drift
 *  check's path filter name the same files (shadcn-drift.test.ts). */
export const VENDORED_FILES = [
  ...SHADCN_ITEMS.map((item) => `packages/ui/src/components/${item}.tsx`),
  "packages/ui/src/components/input-group.tsx",
  "packages/ui/src/hooks/use-mobile.ts",
].sort();

/** Our own stylesheet, into which the CLI merges an item's CSS: only whether it would, is compared. */
const GLOBALS_CSS = "packages/ui/src/styles/globals.css";

/** Each file in the output of `add <items> --dry-run --view src/`, by its path in the repository:
 *  what `add` would do to it and the exact content it would write. The CLI prints a file as
 *  `├ <path> (<action>) <n> lines`, then its lines in a box, each after `│ │ `. Throws when a box
 *  does not hold the line count its header gives. Pure. */
export function parseView(output: string) {
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
    files.push({ path: `packages/ui/${path}`, action: action!, content: content.join("\n") });
  }
  return files;
}

/** What differs from upstream: each vendored file whose bytes are not what `add` would write, a
 *  file `add` writes that is not on the vendored list, a vendored file it no longer writes, and CSS
 *  it would merge into globals.css. `current` reads a file in the repository, or undefined. Pure. */
export function driftOf(
  files: { path: string; action: string; content: string }[],
  current: (path: string) => string | undefined,
) {
  const written = new Set(files.map((file) => file.path));
  return [
    ...files.flatMap((file) => {
      if (file.path === GLOBALS_CSS)
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

/** Runs the pinned CLI in packages/ui with `args` after `add <every item>`. */
function shadcnAdd(args: string[]) {
  return spawnSync(
    "pnpm",
    ["--dir", "packages/ui", "exec", "shadcn", "add", ...SHADCN_ITEMS, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      // the --view output holds every vendored file
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

/** Every file `add` would write, with its content (parseView). Throws with the CLI's output when it
 *  could not print them (the registry is a network call). */
function dryRun() {
  // `--view <path>` shows every file whose path contains it, CSS included, with no cap on count
  const run = shadcnAdd(["--dry-run", "--view", "src/"]);
  const output = `${run.stdout}${run.stderr}`;
  if (run.status === 0 && /^└ Run without --dry-run to apply\.$/m.test(output))
    return parseView(output);
  throw new Error(
    `could not ask the shadcn registry what \`add\` would write: shadcn add --dry-run exited ${run.status}:\n${output}`,
  );
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
    const path = line.split(" ")[0]!.replace(/^packages\/ui\//, "");
    console.log(shadcnAdd(["--dry-run", "--diff", path]).stdout);
  }
  throw new Error(
    `${found.length} vendored shadcn file(s) differ from upstream. Refresh with ` +
      "`node scripts/ci/shadcn-drift.ts refresh` and review the diff; never edit one by hand " +
      "(packages/ui/AGENTS.md).",
  );
}

/** Rewrites every vendored file with `shadcn add <every item> -o -y`. */
export function refresh() {
  const run = shadcnAdd(["-o", "-y"]);
  process.stdout.write(`${run.stdout}${run.stderr}`);
  if (run.status !== 0) throw new Error(`shadcn add exited ${run.status}`);
}

void createCli({ ...import.meta, name: "shadcn-drift" }).run();
