/**
 * Enabling the voice agent in a config repo.
 *
 * The platform builds a config repo's files the way it builds worker.ts,
 * resolving packages from the repo's package.json. So the whole install is
 * two dependency lines and a three-line voice-agent.ts that re-exports the
 * agent from this package: the repo holds a name, not a copy. Before this
 * package existed, `voicelab deploy` committed the agent's source files into
 * every project, and each copy then aged on its own.
 */
import { z } from "zod";
import { VOICE_AGENT_GUEST_FILE } from "./ref.ts";

export const VOICE_AGENT_PACKAGE_NAME = "@iterate-com/voice-agent";

/**
 * The spec a fresh install writes. Every push to iterate/iterate main
 * republishes this package there, and a deployment pins every such spec to
 * the ref it was built with (apps/os/src/pkg-pr-new.ts), so what a project
 * runs is the platform's own build, not whatever main holds at call time.
 */
export const VOICE_AGENT_PACKAGE_SPEC =
  "https://pkg.pr.new/iterate/iterate/@iterate-com/voice-agent@main";

/**
 * `iterate/processors`, which the agent is built on, leaves zod external —
 * an ordinary dependency, like every library entry of the SDK — so the repo
 * has to declare it, at the version the SDK pins (every template does).
 */
export const VOICE_AGENT_ZOD_SPEC = "4.5.4";

/** What the installer writes to voice-agent.ts: the guest, by name. */
export const VOICE_AGENT_GUEST_SOURCE = `// The voice agent guest worker. The platform builds this file (see
// @iterate-com/voice-agent/INSTALL.md); the agent lives in the package and
// this repo holds its name. Subclass here if the project needs to.
export { default, VoiceAgentFacet } from "${VOICE_AGENT_PACKAGE_NAME}/worker";
`;

/** The files a pre-package deploy committed beside voice-agent.ts. Nothing builds from them any more. */
export const LEGACY_GUEST_PATHS = [
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
   * What to do with what is already there — a different spec, or a
   * voice-agent.ts holding something other than the re-export (an old
   * committed copy, or the project's own subclass): `replace` is an upgrade
   * (the CLI's deploy command); `keep` leaves it alone and only fills gaps
   * (an app that just needs the agent present).
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
  /** What the commit touched: "package.json", "voice-agent.ts", or nothing. */
  changedPaths: string[];
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
 * package.json with this package (and zod) declared. Pure, so a caller can
 * see what an install would do before committing it. The layout is
 * JSON.stringify's two-space one, which is also what the platform writes,
 * and the keys keep the file's order.
 */
export function withVoiceAgentDependency(
  packageJson: string,
  options: InstallVoiceAgentOptions,
): { content: string; spec: string; changed: boolean } {
  const { manifest, dependencies } = parseManifest(packageJson);
  const wanted = options.spec ?? VOICE_AGENT_PACKAGE_SPEC;
  const declared = dependencies[VOICE_AGENT_PACKAGE_NAME];
  const spec = declared && (declared === wanted || options.existing === "keep") ? declared : wanted;
  const next = {
    ...dependencies,
    [VOICE_AGENT_PACKAGE_NAME]: spec,
    // A zod the project already pins is its own business.
    zod: dependencies.zod ?? VOICE_AGENT_ZOD_SPEC,
  };
  if (spec === declared && next.zod === dependencies.zod) {
    return { content: packageJson, spec, changed: false };
  }
  const content = JSON.stringify({ ...manifest, dependencies: next }, null, 2);
  return { content: `${content}\n`, spec, changed: true };
}

/**
 * voice-agent.ts as the installer wants it. A file that is already there
 * and holds something else — an old committed copy, or a subclass the
 * project wrote — is kept under `keep` and overwritten under `replace`.
 */
export function withVoiceAgentGuestFile(
  current: string | null,
  existing: InstallVoiceAgentOptions["existing"],
): { content: string; changed: boolean } {
  if (current === VOICE_AGENT_GUEST_SOURCE || (current !== null && existing === "keep")) {
    return { content: current, changed: false };
  }
  return { content: VOICE_AGENT_GUEST_SOURCE, changed: true };
}

/** Commit the dependency lines and the guest file into the repo, in one commit, unless they are already there. */
export async function installVoiceAgent(
  repo: VoiceAgentConfigRepo,
  options: InstallVoiceAgentOptions,
): Promise<InstallVoiceAgentResult> {
  const [manifest, guest] = await Promise.all([
    repo.readFile({ path: "package.json" }),
    repo.readFile({ path: VOICE_AGENT_GUEST_FILE }),
  ]);
  if (manifest === null) {
    throw new Error("The config repo has no package.json, so nothing can declare the voice agent.");
  }
  const dependency = withVoiceAgentDependency(manifest.content, options);
  const guestFile = withVoiceAgentGuestFile(guest?.content ?? null, options.existing);
  const changes = [
    ...(dependency.changed ? [{ path: "package.json", content: dependency.content }] : []),
    ...(guestFile.changed ? [{ path: VOICE_AGENT_GUEST_FILE, content: guestFile.content }] : []),
  ];
  if (changes.length === 0) {
    return {
      changed: false,
      commitOid: manifest.commitOid,
      spec: dependency.spec,
      changedPaths: [],
    };
  }
  const commit = await repo.commitFiles({
    message: options.message ?? `voice-agent: depend on ${dependency.spec}`,
    changes,
  });
  return {
    changed: !commit.noChanges,
    commitOid: commit.commitOid,
    spec: dependency.spec,
    changedPaths: changes.map((change) => change.path),
  };
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
    message: `voice-agent: remove the committed copy's sources; ${VOICE_AGENT_PACKAGE_NAME} builds the agent now`,
    changes: paths.map((path) => ({ path, delete: true as const })),
  });
  return { commitOid: commit.commitOid, paths };
}
