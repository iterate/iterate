// Live proof of the convergence NotesApp: the composer's exact sequence —
// provision the notes repo + workspace, write the note FILE, append the
// captured fact to the workspace's stream — then the server's obligation
// writes title/tags INTO the file's frontmatter (one real model call), the
// settlement-debounced commit lane lands it on the notes repo's main, an
// agent-shaped glob/readFiles finds it, and delete drops it everywhere.
//
//   doppler run --config dev -- pnpm --dir apps/mobile test:e2e   # local dev (pnpm dev must be running)

import { expect, test } from "vitest";
import { connectItx } from "iterate/node";
import { mintForgedAccessToken } from "../../../scripts/auth/forge-token.ts";
import {
  buildCapturedEvent,
  buildDeletedEvent,
  composeNoteFile,
  noteFilePath,
  NOTES_REPO_PATH,
  NOTES_WORKSPACE_PATH,
  parseNoteFile,
} from "../src/lib/notes.ts";
import { portlessOrigin, requireEnv, resolveBaseUrl } from "./e2e-helpers.ts";

test(
  "a captured note file gets analyzed frontmatter, a git commit, and agent-shaped discovery",
  { timeout: 240_000 },
  async () => {
    const baseUrl = resolveBaseUrl();

    using adminSession = connectItx({
      baseUrl,
      auth: { type: "admin-secret", secret: requireEnv("APP_CONFIG_ADMIN_API_SECRET") },
    });
    const slug = `mobile-notes-e2e-${Date.now().toString(36)}`;
    const created = await adminSession.projects.get(slug).create({});
    const { projectId } = await created.__describe();

    const token = await mintForgedAccessToken({
      forgePrivateJwk: requireEnv("AUTH_FORGE_ES256_PRIVATE_JWK"),
      issuer: requireEnv("APP_CONFIG_ITERATE_AUTH__ISSUER"),
      audience: process.env.APP_CONFIG_ITERATE_AUTH__RESOURCE?.trim() || portlessOrigin(baseUrl),
      email: "mobile-notes-e2e@nustom.com",
      admin: true,
    });
    using project = connectItx({ baseUrl, auth: { type: "bearer", token }, projectId });

    // The composer's exact sequence (components/note-composer.tsx): lazy
    // provisioning, file write, captured fact. No AI in the capture path.
    await project.repos.get(NOTES_REPO_PATH).create({ type: "empty" });
    const workspace = project.workspaces.get(NOTES_WORKSPACE_PATH);
    await workspace.create({});
    const capturedAt = new Date().toISOString();
    const path = noteFilePath(capturedAt, "e2e1");
    await workspace.writeFile(
      path,
      composeNoteFile({ capturedAt }, "Standing desk height: 76cm was exactly right at the office"),
    );
    await project.streams.get(NOTES_WORKSPACE_PATH).append(buildCapturedEvent(path));

    // The obligation settles by writing title/tags INTO the file.
    const analyzed = await pollUntil(async () => {
      const content = await workspace.readFile(path);
      if (!content) return null;
      const note = parseNoteFile(content);
      return typeof note.frontmatter.title === "string" && note.frontmatter.title !== ""
        ? note
        : null;
    });
    expect(analyzed.frontmatter).toMatchObject({ capturedAt, title: expect.any(String) });
    expect(analyzed.body).toContain("76cm");

    // The settlement event is the durable proof of the same fact.
    const settled = await project.streams.get(NOTES_WORKSPACE_PATH).getEvents({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/notes/analysis-settled"],
    });
    expect(settled).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          path,
          result: expect.objectContaining({
            status: "succeeded",
            processedBy: expect.stringContaining("@cf/"),
          }),
        }),
      }),
    );

    // The commit lane lands the note on the repo's main (~10s debounce).
    const commit = await pollUntil(async () => {
      const log = await workspace.git.log({ scope: NOTES_REPO_PATH, limit: 5 });
      return log.find((entry: any) => entry.message.startsWith("notes:")) || null;
    });
    expect(commit.message).toMatch(/^notes: /);

    // Agent-shaped discovery: plain glob + readFiles, no special capability.
    const found = await workspace.glob(`${NOTES_REPO_PATH}/*.md`);
    expect(found).toContain(path);

    // Delete: file gone, fact appended, list-shaped glob no longer sees it.
    await workspace.deleteFile(path);
    await project.streams.get(NOTES_WORKSPACE_PATH).append(buildDeletedEvent(path));
    expect(await workspace.readFile(path)).toBeNull();
    expect(await workspace.glob(`${NOTES_REPO_PATH}/*.md`)).not.toContain(path);
  },
);

async function pollUntil<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 180_000;
  while (true) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
