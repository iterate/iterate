/*
 * WHAT ACTUALLY GETS COMMITTED, AND WHETHER IT CAN BUILD.
 *
 * `installVoiceAgent` copies the guest worker into a project's config repo,
 * and the dynamic worker is then built FROM REPO FILES ALONE. So an import
 * that was never committed compiles perfectly on the machine that has the file
 * and dies at the project's cold start with `No such module` — a failure whose
 * only symptom is that every call into the worker throws, hours after the
 * commit that caused it, on somebody else's deployment.
 *
 * That is not a hypothetical. The list of files to carry alongside
 * voice-agent.ts was hand-written, the speaker rewrite extracted `speaker.ts`,
 * nobody added it, and the deployed guest could not be built at all. MEASURED
 * on preview-3, first run of the paced proof:
 *
 *     Failed to resolve './speaker.ts' from voice-agent.ts: file does not
 *     exist (kept as an external import)
 *
 * A hand-maintained second copy of a list the source already contains will
 * drift; the same lesson is written out at length in voice-agent.ts about the
 * subscription filter and `consumes`. So the assertion here is not "speaker.ts
 * is in the list" — that is one bug, and a list can lose the next file just as
 * easily. It is that the committed set is CLOSED under relative imports: every
 * `./x.ts` reachable from the entry point is itself committed.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { installVoiceAgent } from "./deploy.ts";

/**
 * Relative specifiers only — packages resolve from the platform, not the repo.
 *
 * Written out again here rather than imported from `deploy.ts`, and that is
 * the point: a test that reuses the implementation's own idea of what an
 * import looks like agrees with it by construction, including when it is
 * wrong.
 */
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g;

/**
 * Run the real install against a repo that only remembers what it was handed.
 *
 * Driving `installVoiceAgent` rather than reading its constants is what keeps
 * this test true through the fix: the list may become a derivation, a manifest
 * or a bundler, and the question — what arrived in the repo? — does not change.
 */
async function committedFiles(): Promise<Map<string, string>> {
  const captured = new Map<string, string>();
  await installVoiceAgent({
    repo: {
      readFile: async () => null,
      commitFiles: async ({ changes }: { changes: { path: string; content: string }[] }) => {
        for (const change of changes) captured.set(change.path, change.content);
        return {
          changedPaths: changes.map((change) => change.path),
          commitOid: "0".repeat(40),
          noChanges: false,
        };
      },
    },
  });
  return captured;
}

describe("installing the voice agent into a project's config repo", () => {
  it("carries every module voice-agent.ts imports at runtime", async () => {
    const committed = await committedFiles();
    const missing: string[] = [];
    for (const [path, content] of committed) {
      for (const match of content.matchAll(RELATIVE_IMPORT)) {
        const specifier = match[1]!;
        /* The repo is FLAT: everything lands at the root next to the entry
         * point, so a specifier that climbs out of it cannot be committed at
         * all and is a different bug with a different fix. */
        expect(
          specifier.startsWith("./"),
          `${path} imports ${specifier} from outside the repo`,
        ).toBe(true);
        const wanted = specifier.slice(2);
        if (!committed.has(wanted)) missing.push(`${path} imports ${specifier}`);
      }
    }
    expect(missing, "these imports would be `No such module` at the project's cold start").toEqual(
      [],
    );
  });

  it("commits the entry point the worker ref names", async () => {
    /* `voice-agent-ref.ts` names `voice-agent.ts` as the entryPoint, so a
     * commit that renamed or dropped it would build nothing at all. */
    const committed = await committedFiles();
    expect([...committed.keys()]).toContain("voice-agent.ts");
  });

  it("carries the viseme model as source, because a .bin cannot make the trip", async () => {
    /* Repo files are read as text. The model rides inside a generated .ts for
     * exactly that reason, and it is the one committed file nothing imports
     * from voice-agent.ts directly — so the closure test above reaches it only
     * through viseme.ts, and this says out loud that it must arrive. */
    const committed = await committedFiles();
    expect(committed.get("viseme-model.generated.ts")?.length ?? 0).toBeGreaterThan(1_000);
  });

  it("sends the file on disk, not a stale copy of it", async () => {
    const committed = await committedFiles();
    const onDisk = fs.readFileSync(
      new URL("../../../../configs/voice-agent/voice-agent.ts", import.meta.url).pathname,
      "utf8",
    );
    expect(committed.get("voice-agent.ts")).toBe(onDisk);
  });
});
