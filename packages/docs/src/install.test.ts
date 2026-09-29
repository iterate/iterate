import { expect, test } from "vitest";
import { DocContract, DocsContract } from "./contract.ts";
import { ensureDoc } from "./install.ts";

// install.ts spells the processors' consumes itself: the page imports it, and contract.ts pulls in
// iterate/stream/processor, which a browser can't load
test("opening a doc enables each processor on everything its contract consumes", async () => {
  const enabled: Record<string, unknown> = {};
  const context = (path: string): any => ({
    cd: context,
    append: async () => [],
    processors: {
      enable: async (slug: string, row: { consumes: string[] }) => {
        enabled[`${path} ${slug}`] = row.consumes;
      },
    },
  });

  await ensureDoc(context("/"), { repo: "/repos/config", path: "plan.md" });

  expect(enabled).toEqual({
    "/ docs": DocsContract.consumes,
    "/docs/config/plan.md doc": DocContract.consumes,
  });
});
