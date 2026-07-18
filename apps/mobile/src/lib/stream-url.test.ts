import { expect, test } from "vitest";
import { buildStreamViewerUrl } from "./stream-url.ts";

test("builds the dashboard URL for an agent stream on the selected deployment", () => {
  expect(
    buildStreamViewerUrl({
      baseUrl: "https://os.iterate-preview-6.com/path?stale=yes",
      projectSlug: "groceries & errands",
      streamPath: "/agents/mobile/2026-07-18",
    }),
  ).toBe(
    "https://os.iterate-preview-6.com/projects/groceries%20%26%20errands/streams/agents/mobile/2026-07-18",
  );
});

test("keeps the root stream distinct from the streams index", () => {
  expect(
    buildStreamViewerUrl({
      baseUrl: "https://os.iterate.com",
      projectSlug: "iterate",
      streamPath: "/",
    }),
  ).toBe("https://os.iterate.com/projects/iterate/streams/%2F");
});
