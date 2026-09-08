/**
 * Declaring the voice agent in a config repo.
 *
 * The guest worker is built from node_modules, so a project opts in by naming
 * this package in its config repo's package.json — one line, which the
 * platform's dynamic worker host resolves and builds on the first call into
 * the guest. Nothing else travels. Before this package existed, `voicelab
 * deploy` committed the agent's source files into every project, and each
 * copy then aged on its own.
 */

import { z } from "zod";

export const VOICE_AGENT_PACKAGE_NAME = "@iterate-com/voice-agent";

/**
 * The spec a fresh install writes. Every push to iterate/iterate main
 * republishes this package there, and a deployment pins every such spec to
 * the ref it was built with (apps/os/src/pkg-pr-new.ts), so what a project
 * runs is the platform's own build, not whatever main holds at call time.
 */
export const VOICE_AGENT_PACKAGE_SPEC =
  "https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@main";

/** The files a pre-package deploy committed. Nothing builds from them any more. */
export const LEGACY_GUEST_PATHS = [
  "voice-agent.ts",
  "face.ts",
  "pcm.ts",
  "viseme.ts",
  "viseme-model.generated.ts",
] as const;

/** The slice of a project's config repo handle the installer uses. */
export interface VoiceAgentConfigRepo {
  readFile: (input: { path: string }) => Promise<{ commitOid: string; content: string } | null>;
  commitFiles: (input: {
    message: string;
    changes: ({ path: string; content: string } | { path: string; delete: true })[];
  }) => Promise<{ commitOid: string; changedPaths: string[]; noChanges: boolean }>;
}

export interface InstallVoiceAgentOptions {
  /** Spec to write; default {@link VOICE_AGENT_PACKAGE_SPEC}. */
  spec?: string;
  /**
   * What to do when package.json already names the package under another
   * spec: `replace` is an upgrade (the CLI's deploy command); `keep` leaves a
   * deliberate pin alone (an app that only needs the package present).
   */
  existing: "keep" | "replace";
  message?: string;
}

export interface InstallVoiceAgentResult {
  /** Head after the install: the new commit, or the one already there. */
  commitOid: string;
  changed: boolean;
  /** The spec package.json names now. */
  spec: string;
}

/** A package.json as JSON.parse hands it over: an object, keys in file order. */
const PackageManifest = z.record(z.string(), z.unknown());
/** The dependencies map: package names to specs. */
const DependencySpecs = z.record(z.string(), z.string());

/** package.json checked at the boundary, or an error that says what is wrong with it. */
function parseManifest(content: string): {
  manifest: Record<string, unknown>;
  dependencies: Record<string, string>;
} {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    throw new Error(`package.json is not valid JSON: ${String(error)}`);
  }
  const manifest = PackageManifest.safeParse(json);
  if (!manifest.success) {
    throw new Error(`package.json must hold a JSON object: ${z.prettifyError(manifest.error)}`);
  }
  const dependencies = DependencySpecs.optional().safeParse(manifest.data.dependencies);
  if (!dependencies.success) {
    throw new Error(
      `package.json dependencies must map names to specs: ${z.prettifyError(dependencies.error)}`,
    );
  }
  return { manifest: manifest.data, dependencies: dependencies.data ?? {} };
}

/**
 * package.json with this package declared. Pure, so a caller can see what an
 * install would do before committing it. The layout is JSON.stringify's
 * two-space one, which is also what the platform writes.
 */
export function withVoiceAgentDependency(
  packageJson: string,
  options: InstallVoiceAgentOptions,
): { content: string; spec: string; changed: boolean } {
  const { manifest, dependencies } = parseManifest(packageJson);
  const wanted = options.spec ?? VOICE_AGENT_PACKAGE_SPEC;
  const declared = dependencies[VOICE_AGENT_PACKAGE_NAME];
  if (declared !== undefined && (declared === wanted || options.existing === "keep")) {
    return { content: packageJson, spec: declared, changed: false };
  }
  const content = JSON.stringify(
    { ...manifest, dependencies: { ...dependencies, [VOICE_AGENT_PACKAGE_NAME]: wanted } },
    null,
    2,
  );
  return { content: `${content}\n`, spec: wanted, changed: true };
}

/** Commit the dependency into the repo's package.json unless it is already there. */
export async function installVoiceAgent(
  repo: VoiceAgentConfigRepo,
  options: InstallVoiceAgentOptions,
): Promise<InstallVoiceAgentResult> {
  const manifest = await repo.readFile({ path: "package.json" });
  if (manifest === null) {
    throw new Error("The config repo has no package.json, so nothing can declare the voice agent.");
  }
  const next = withVoiceAgentDependency(manifest.content, options);
  if (!next.changed) {
    return { changed: false, commitOid: manifest.commitOid, spec: next.spec };
  }
  const commit = await repo.commitFiles({
    message: options.message ?? `voice-agent: depend on ${next.spec}`,
    changes: [{ path: "package.json", content: next.content }],
  });
  return { changed: !commit.noChanges, commitOid: commit.commitOid, spec: next.spec };
}

/** Which of the pre-package source files the repo still carries. */
export async function legacyGuestPaths(
  repo: Pick<VoiceAgentConfigRepo, "readFile">,
): Promise<string[]> {
  const present = await Promise.all(
    LEGACY_GUEST_PATHS.map(async (path) =>
      (await repo.readFile({ path })) === null ? null : path,
    ),
  );
  return present.filter((path) => path !== null);
}

/**
 * Delete the pre-package source files in one commit. Null when the repo has
 * none, so a caller can tell "nothing to do" from "removed".
 */
export async function removeLegacyGuest(
  repo: VoiceAgentConfigRepo,
): Promise<{ commitOid: string; paths: string[] } | null> {
  const paths = await legacyGuestPaths(repo);
  if (paths.length === 0) return null;
  const commit = await repo.commitFiles({
    message: `voice-agent: remove the committed copy; ${VOICE_AGENT_PACKAGE_NAME} builds it now`,
    changes: paths.map((path) => ({ path, delete: true as const })),
  });
  return { commitOid: commit.commitOid, paths };
}
