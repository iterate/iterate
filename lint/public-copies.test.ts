import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { expect, test } from "vitest";

// The public copies (copybara/copy.bara.sky), github.com/iterate/core and iterate/packages, hold
// only some of this repository's folders, and what is written in those folders is read there.

const repoRoot = resolve(import.meta.dirname, "..");

// A relative markdown link from core/ to docs/ or test/ is dead on github.com/iterate/core. Link
// outside a copy with a github.com URL, or name the path without linking it. Fails naming each
// dead link.
test("a public copy's markdown links only to files the copy holds", () => {
  const dead: string[] = [];
  for (const copy of publicCopies()) {
    const folders = new Set(
      [...copy.sources.keys()].flatMap((path) => {
        const ancestors = [];
        for (let folder = dirname(path); folder !== "."; folder = dirname(folder))
          ancestors.push(folder);
        return ancestors;
      }),
    );
    for (const [path, source] of copy.sources) {
      // the AI linter's fixtures are rule files copied verbatim, links and all
      if (!path.endsWith(".md") || source.includes("/fixtures/")) continue;
      for (const [, href] of readFileSync(join(repoRoot, source), "utf8").matchAll(
        /\]\(([^)\s]+)\)/g,
      )) {
        if (/^([a-z]+:|#)/.test(href)) continue;
        const target = normalize(join(dirname(path), href.split("#")[0])).replace(/\/$/, "");
        if (!copy.sources.has(target) && !folders.has(target))
          dead.push(`iterate/${copy.name}: ${path} links ${href}`);
      }
    }
  }
  expect(dead).toEqual([]);
});

// On github.com/iterate/core a bare `#2922` reads as iterate/core's issue 2922, not the
// iterate/iterate PR it meant. Name the repository: iterate/iterate#2922 for a PR from before the
// move to iterate/private, iterate/private#N after it, workerd#6800 for another project's. A `#`
// and 3–5 digits with no leading zero counts, so colours (`#000`, `#171717`) pass and `#1`, far
// more often a list item than a PR, is not checked. Inside backticks it is literal text, as it is
// to GitHub. Fails naming each file, line and ref.
test("a public copy names a PR or issue as owner/repo#N, never a bare #N", () => {
  const bare: string[] = [];
  for (const copy of publicCopies()) {
    for (const source of copy.sources.values()) {
      if (source.includes("/fixtures/") || BINARY_FILE.test(source)) continue;
      readFileSync(join(repoRoot, source), "utf8")
        .split("\n")
        .forEach((line, index) => {
          for (const [ref] of line.replaceAll(/`[^`]*`/g, "").matchAll(BARE_REF))
            bare.push(`iterate/${copy.name}: ${source}:${index + 1} ${ref}`);
        });
    }
  }
  expect(bare).toEqual([]);
});

// Nothing in a public copy looks like a key or an id: a UUID, a long hex, base64 or digit run, a
// token's or a key's own shape. An account id or an analytics key belongs in iterate/private
// (envs.ts), a secret in Doppler. Obvious test data passes: few distinct characters
// (`00000000-0000-4000-8000-000000000001`, `1700000000`) or runs of one
// (`aaaaabbbbbccccc111112222233333aaaaabbbbb`). A string that has to stay takes a line
// above it saying `allow-high-entropy-next-line: <why>`, in the file's own comment syntax. The
// copied lockfile's package checksums, and a patch's `index <blob>..<blob>` lines (git's ids of the
// npm package's files), are not ours. Fails naming each file, line and string.
test("a public copy holds no high-entropy string: no key, id, hash or token", () => {
  const found: string[] = [];
  const sources = new Set(publicCopies().flatMap((copy) => [...copy.sources.values()]));
  for (const source of sources) {
    if (BINARY_FILE.test(source) || source === "copybara/core/pnpm-lock.yaml") continue;
    const lines = readFileSync(join(repoRoot, source), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (lines[index - 1]?.includes("allow-high-entropy-next-line")) return;
      if (source.endsWith(".patch") && /^index [0-9a-f]+\.\.[0-9a-f]+/.test(line)) return;
      for (const string of highEntropyStrings(line))
        found.push(`${source}:${index + 1} ${string.slice(0, 60)}`);
    });
  }
  expect(found).toEqual([]);
});

const BARE_REF = /(?<![\w/&#-])#[1-9]\d{2,4}\b/g;
const BINARY_FILE = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|wasm|bin)$/i;

/** Each public copy and every file it holds: the path in the copy → the file here it is copied
 *  from. */
function publicCopies() {
  const copies = [
    // copy.bara.sky's origin_files (a trailing / is a folder), and copybara/<name>/, which lands
    // at the copy's root
    {
      name: "core",
      paths: ["core/", "patches/", "tsconfig.base.json", "tsconfig.app.json", ".nvmrc", "LICENSE"],
      rootFiles: "copybara/core/",
    },
    {
      name: "packages",
      paths: ["packages/", "configs/", "LICENSE"],
      rootFiles: "copybara/packages/",
    },
  ];
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  return copies.map((copy) => {
    const sources = new Map<string, string>();
    for (const file of tracked) {
      if (copy.paths.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path)))
        sources.set(file, file);
      if (file.startsWith(copy.rootFiles)) sources.set(file.slice(copy.rootFiles.length), file);
    }
    return { name: copy.name, sources };
  });
}

/** The high-entropy strings in a line. Once a check reports a string, later checks skip it: a
 *  UUID's last group is not reported again as a digit run. */
function highEntropyStrings(line: string) {
  const claimed: [number, number][] = [];
  const found: string[] = [];
  const check = (pattern: RegExp, text: string, highEntropy: (match: string) => boolean) => {
    for (const { 0: match, index: start } of text.matchAll(pattern)) {
      const end = start + match.length;
      if (claimed.some(([claimedStart, claimedEnd]) => start < claimedEnd && end > claimedStart))
        continue;
      if (!highEntropy(match)) continue;
      claimed.push([start, end]);
      found.push(match);
    }
  };
  // a key's or a token's own shape, unless typed (`phc_aaaaabbbbbccccc…`): no entropy floor
  for (const pattern of KEY_SHAPES) check(pattern, line, (key) => looksRandom(key, 0));
  check(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, line, (uuid) => {
    return looksRandom(uuid.replaceAll("-", ""), 2.5);
  });
  // 16 is a personal access token's id (`pat_<16 hex>`); minted ids and Cloudflare's are 32
  check(/(?<![0-9A-Za-z])[0-9a-f]{16,}(?![0-9A-Za-z])/gi, line, (hex) => looksRandom(hex, 2.5));
  // URLs blanked out first: a path like `docs/Web/API/CanvasRenderingContext2D` reads as base64
  const outsideUrls = line.replaceAll(/https?:\/\/\S+/g, (url) => " ".repeat(url.length));
  check(/(?<![\w+/-])[\w+/-]{32,}={0,2}(?![\w+/=-])/g, outsideUrls, (run) => {
    return /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) && bitsPerCharacter(run) >= 4.2;
  });
  check(/(?<![\w.])\d{9,}(?!\w)/g, line, (digits) => looksRandom(digits, 2));
  return found;
}

/** Whether a string could be random rather than typed: enough bits per character, and a new
 *  character at more than half its positions. A typed fake (`aaaaabbbbbccccc`) changes character
 *  every 5; a random id almost every time. */
function looksRandom(text: string, minimumBits: number) {
  const runs = [...text].filter((character, index) => character !== text[index - 1]).length;
  return bitsPerCharacter(text) >= minimumBits && runs * 2 > text.length;
}

/** Shannon entropy in bits per character: 0 for `0000`, 4 for hex using every digit equally. */
function bitsPerCharacter(text: string) {
  const counts = new Map<string, number>();
  for (const character of text) counts.set(character, (counts.get(character) || 0) + 1);
  return [...counts.values()].reduce(
    (bits, count) => bits - (count / text.length) * Math.log2(count / text.length),
    0,
  );
}

const KEY_SHAPES = [
  /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/g,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/g, // a JWT
  /\bsha(1|256|384|512)-[A-Za-z0-9+/]{20,}={0,2}/g, // a package checksum
  /\b(sk-(ant-)?[\w-]{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|phc_\w{20,}|AKIA[0-9A-Z]{16})/g,
  /\b(xox[abpr]-[\w-]{10,}|AIza[\w-]{30,}|[spr]k_(live|test)_\w{10,}|whsec_\w{10,}|re_\w{20,})/g,
  /\bdp\.(st|pt|sa)\.[\w.-]{20,}/g, // a Doppler token
];
