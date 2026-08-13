/**
 * typm — like pnpm, but just for types.
 *
 * Reads a package.json, recursively pulls its npm dependencies over jsdelivr,
 * and keeps only the `.d.ts` files (plus each package's own package.json, which
 * TypeScript's module resolution needs for `types`/`exports` lookups). The
 * result is a `/node_modules/...` file map ready to drop into a virtual
 * TypeScript environment such as `@typescript/vfs`.
 *
 * Lockfiles are deliberately not respected: semver ranges are resolved to
 * concrete versions through jsdelivr's resolve API at acquisition time.
 *
 * Attribution: the CDN strategy — jsdelivr's resolve endpoint for
 * range→version resolution, the `/flat` file listing, `cdn.jsdelivr.net` for
 * contents, the declaration-file regex (incl. `.d.mts`/`.d.cts`), and the
 * DefinitelyTyped name mangling (`@scope/name` → `scope__name`) — is borrowed
 * from Microsoft's `@typescript/ata`
 * (https://github.com/microsoft/TypeScript-Website/tree/v2/packages/ata, MIT).
 * Modifications: acquisition is driven by package.json dependency maps rather
 * than source-import scanning, transitive dependencies resolve at their
 * declared ranges rather than `latest`, `@types/*` fallbacks are major-version
 * matched, and the loop adds budget caps, peer-dependency handling, and an
 * injected fetch (for tests and caching policy).
 */

export interface TypmLimits {
  /** Stop enqueueing new packages past this count (cycle/explosion fuse). */
  maxPackages: number;
  /** Total download budget; a package that would exceed it is skipped whole. */
  maxTotalBytes: number;
}

export interface AcquireTypesInput {
  /** Raw package.json text of the root project. Throws if unparseable. */
  packageJson: string;
  fetch: (url: string) => Promise<Response>;
  log: (message: string) => void;
  limits: TypmLimits;
}

export interface AcquiredPackage {
  name: string;
  version: string;
  fileCount: number;
  bytes: number;
}

export interface AcquireTypesResult {
  /** vfs-ready map: `/node_modules/<name>/<path>` → contents. */
  files: Record<string, string>;
  packages: AcquiredPackage[];
  warnings: string[];
  /**
   * Packages lost to a THROWN fetch (offline, DNS failure, dropped
   * connection) — transient-shaped, worth retrying later. Warnings alone
   * (resolve 404s, unfetchable specifiers, packages shipping no types) are
   * the registry's honest answer and do NOT count: an empty result with
   * zero failures means the manifest genuinely has nothing acquirable.
   */
  failures: number;
  totalBytes: number;
}

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

/** A dependency to acquire: ranges are tried in order until one resolves. */
interface PendingDependency {
  name: string;
  ranges: string[];
}

const FILE_FETCH_CONCURRENCY = 8;

/** Charged per file against the byte budget, so the budget bounds the
 * NUMBER of CDN requests as well as their size (see the fan-out comment). */
const PER_FILE_OVERHEAD_BYTES = 512;

export async function acquireTypes(input: AcquireTypesInput): Promise<AcquireTypesResult> {
  const root = JSON.parse(input.packageJson) as PackageJsonShape;
  const files: Record<string, string> = {};
  const packages: AcquiredPackage[] = [];
  const warnings: string[] = [];
  let failures = 0;
  let totalBytes = 0;
  /** Package names ever enqueued — the vfs node_modules is flat, so one
   * version per name and the FIRST resolution wins (top-level dependencies
   * are wave 0, so directs always beat transitives). */
  const seen = new Set<string>();
  let capWarned = false;
  const warn = (message: string) => {
    warnings.push(message);
    input.log(`warning: ${message}`);
  };
  const limitFileFetch = createLimiter(FILE_FETCH_CONCURRENCY);

  const fetchJson = async (url: string): Promise<unknown> => {
    const response = await input.fetch(url);
    if (!response.ok) return null;
    return response.json();
  };

  const resolveVersion = async (dependency: PendingDependency): Promise<string | null> => {
    for (const range of dependency.ranges) {
      const url = `https://data.jsdelivr.com/v1/package/resolve/npm/${dependency.name}@${encodeURIComponent(range)}`;
      const resolved = (await fetchJson(url)) as { version?: string | null } | null;
      if (resolved && typeof resolved.version === "string") return resolved.version;
    }
    return null;
  };

  /** Acquire one package; returns the dependencies it wants pulled next. */
  const acquireOne = async (dependency: PendingDependency): Promise<PendingDependency[]> => {
    const { name } = dependency;
    const version = await resolveVersion(dependency);
    if (!version) {
      warn(`could not resolve ${name}@${dependency.ranges.join(" | ")}`);
      return [];
    }
    const tree = (await fetchJson(
      `https://data.jsdelivr.com/v1/package/npm/${name}@${version}/flat`,
    )) as { files: Array<{ name: string; size: number }> } | null;
    if (!tree || !Array.isArray(tree.files)) {
      warn(`could not list files for ${name}@${version}`);
      return [];
    }
    const declarationFiles = tree.files.filter((file) => isDeclarationPath(file.name));
    if (!declarationFiles.length) {
      // No shipped types: fall back to DefinitelyTyped, preferring the @types
      // major that matches the resolved package version over blindly-latest.
      const typesPackage = `@types/${definitelyTypedName(name)}`;
      const major = version.split(".")[0]!;
      return [{ name: typesPackage, ranges: [major, "latest"] }];
    }
    // EVERY package.json in the tree, not just the root one: pre-`exports`
    // packages route subpath types through per-directory package.jsons
    // (`pkg/sub/package.json` with a `types` field — older rxjs/date-fns
    // layouts), and they're tiny. The root one additionally drives the
    // dependency recursion below.
    const packageJsonEntries = tree.files.filter((file) => file.name.endsWith("/package.json"));
    const packageJsonEntry = packageJsonEntries.find((file) => file.name === "/package.json");
    const wanted = [...declarationFiles, ...packageJsonEntries];
    // Charge a flat per-file overhead so the byte budget also bounds request
    // FAN-OUT: a hostile listing reporting thousands of zero-size files would
    // otherwise pass the precheck while triggering a fetch per file.
    const bytes = wanted.reduce((sum, file) => sum + (file.size || 0) + PER_FILE_OVERHEAD_BYTES, 0);
    if (totalBytes + bytes > input.limits.maxTotalBytes) {
      warn(
        `skipping ${name}@${version}: ${bytes} bytes (incl. per-file overhead) would exceed the ${input.limits.maxTotalBytes} byte budget`,
      );
      return [];
    }
    totalBytes += bytes;
    const downloaded = await Promise.all(
      wanted.map((file) =>
        limitFileFetch(async () => {
          const response = await input.fetch(
            `https://cdn.jsdelivr.net/npm/${name}@${version}${file.name}`,
          );
          if (!response.ok) {
            warn(`could not download ${name}@${version}${file.name}`);
            return null;
          }
          const content = await response.text();
          files[`/node_modules/${name}${file.name}`] = content;
          return { file, content };
        }),
      ),
    );
    const succeeded = downloaded.filter((download) => !!download);
    packages.push({ name, version, fileCount: succeeded.length, bytes });
    const packageJsonDownload = succeeded.find((download) => download.file === packageJsonEntry);
    if (!packageJsonDownload) return [];
    try {
      const parsed = JSON.parse(packageJsonDownload.content) as PackageJsonShape;
      return transitiveDependencies(parsed);
    } catch {
      warn(`unparseable package.json for ${name}@${version}`);
      return [];
    }
  };

  let wave = rootDependencies(root);
  input.log(`acquiring types for ${wave.length} package.json dependencies`);
  while (wave.length) {
    const batch: PendingDependency[] = [];
    for (const dependency of wave) {
      if (seen.has(dependency.name)) continue;
      if (seen.size >= input.limits.maxPackages) {
        if (!capWarned) {
          capWarned = true;
          warn(`stopped after ${input.limits.maxPackages} packages (maxPackages)`);
        }
        continue;
      }
      seen.add(dependency.name);
      if (!isValidPackageName(dependency.name)) {
        warn(`skipping ${JSON.stringify(dependency.name)}: not a valid npm package name`);
        continue;
      }
      const unfetchable = unfetchableRangeReason(dependency.ranges[0]!);
      if (unfetchable) {
        warn(`skipping ${dependency.name}: ${unfetchable}`);
        continue;
      }
      batch.push(dependency);
    }
    const nextDependencies = await Promise.all(
      batch.map((dependency) =>
        // A THROWN fetch (network blip — unlike a non-ok response) must cost
        // only its own package, not reject the wave and discard every
        // completed one: degradation is per-package.
        acquireOne(dependency).catch((error) => {
          failures += 1;
          warn(`failed to acquire ${dependency.name}: ${String(error)}`);
          return [];
        }),
      ),
    );
    wave = nextDependencies.flat();
  }

  const totalFiles = Object.keys(files).length;
  input.log(
    `acquired ${packages.length} packages (${totalFiles} files, ${Math.round(totalBytes / 1024)} kB): ${packages
      .map((acquired) => `${acquired.name}@${acquired.version}`)
      .join(", ")}`,
  );
  return { files, packages, warnings, failures, totalBytes };
}

/** Top level: regular + dev dependencies (real repos keep `@types/*` in dev). */
function rootDependencies(packageJson: PackageJsonShape): PendingDependency[] {
  const combined = { ...packageJson.devDependencies, ...packageJson.dependencies };
  return Object.entries(combined).map(([name, range]) => ({ name, ranges: [range] }));
}

/** Transitive: regular dependencies plus non-optional peers (types commonly
 * reference peer packages — e.g. a react library's d.ts imports "react"). */
function transitiveDependencies(packageJson: PackageJsonShape): PendingDependency[] {
  const peerEntries = Object.entries(packageJson.peerDependencies || {}).filter(
    ([name]) => !(packageJson.peerDependenciesMeta || {})[name]?.optional,
  );
  const combined = { ...Object.fromEntries(peerEntries), ...packageJson.dependencies };
  return Object.entries(combined).map(([name, range]) => ({ name, ranges: [range] }));
}

/** Same regex family as @typescript/ata: matches .d.ts, .d.mts, .d.cts and
 * flavored variants like .d.worker.ts. */
function isDeclarationPath(path: string): boolean {
  return /\.d\.([^.]+\.)?[cm]?ts$/i.test(path);
}

/** DefinitelyTyped package-name mangling, e.g. `@scope/name` → `scope__name`
 * (as in dts-gen / @typescript/ata). */
function definitelyTypedName(packageName: string): string {
  if (packageName.startsWith("@") && packageName.includes("/")) {
    return packageName.slice(1).replace("/", "__");
  }
  return packageName;
}

/** Ranges the public npm CDN can't serve (local/git/url specifiers). */
function unfetchableRangeReason(range: string): string | null {
  const match = /^(workspace:|file:|link:|portal:|git|github:|https?:)/.exec(range);
  return match ? `unsupported version range "${range}"` : null;
}

/**
 * Names come from user-editable package.jsons (and from fetched transitive
 * ones) but get interpolated into request URLs and vfs paths — npm's name
 * grammar (uppercase kept for legacy unscoped packages like JSONStream)
 * keeps `..`, `/`, `?`, `#`, and whitespace out of both.
 */
function isValidPackageName(name: string): boolean {
  return (
    name.length <= 214 && /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-zA-Z0-9~-][a-zA-Z0-9._~-]*$/.test(name)
  );
}

function createLimiter(max: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return async function limited<T>(fn: () => Promise<T>): Promise<T> {
    // Loop, don't `if`: a fresh synchronous caller can barge past a woken
    // waiter (it resumes a microtask later), so every wake re-checks.
    while (active >= max) await new Promise<void>((resolve) => waiters.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = waiters.shift();
      if (next) next();
    }
  };
}
