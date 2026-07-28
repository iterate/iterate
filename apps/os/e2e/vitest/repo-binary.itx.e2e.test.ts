import { expect, test } from "vitest";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test("commitFiles contentBase64 and readFile base64 round-trip bytes exactly", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(`repo-binary-${crypto.randomUUID()}`).create({});

  // The project repo seeds asynchronously after project creation; readFile
  // THROWS (not null) until the repo artifact exists, so swallow errors
  // while polling.
  await waitForCondition(
    async () => {
      const read = await project.repo.readFile({ path: "package.json" }).catch(() => null);
      return read !== null;
    },
    { description: "project repo to be seeded", intervalMs: 1_000, timeoutMs: 60_000 },
  );

  // PNG magic followed by invalid-utf8 continuation bytes — exactly the
  // content the text lane would corrupt.
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x01,
  ]);
  const base64 = btoa(String.fromCharCode(...bytes));

  const commit = await project.repo.commitFiles({
    message: "Add binary fixture",
    changes: [{ path: "assets/pixel.png", contentBase64: base64 }],
  });
  expect(commit).toMatchObject({
    changedPaths: ["assets/pixel.png"],
    noChanges: false,
  });

  const read = await project.repo.readFile({ path: "assets/pixel.png", encoding: "base64" });
  expect(read).toMatchObject({ content: base64, path: "assets/pixel.png" });

  // The base64 lane reads text files too — same bytes, different encoding.
  // atob yields one CHAR PER BYTE (latin-1), so UTF-8 decode those bytes
  // before comparing to the text lane — the template contains non-ASCII.
  const packageJson = await project.repo.readFile({ path: "package.json" });
  const packageJsonBase64 = await project.repo.readFile({
    path: "package.json",
    encoding: "base64",
  });
  const packageJsonBytes = Uint8Array.from(atob(packageJsonBase64!.content), (char) =>
    char.charCodeAt(0),
  );
  expect(new TextDecoder().decode(packageJsonBytes)).toBe(packageJson!.content);

  // Missing paths are null on the base64 lane as well.
  expect(await project.repo.readFile({ path: "nope.png", encoding: "base64" })).toBeNull();
});
