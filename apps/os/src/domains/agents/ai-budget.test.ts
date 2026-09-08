import { expect, test } from "vitest";
import { readAiBudgetStop } from "./ai-budget.ts";

test("OpenAI spend codes are budget stops, ordinary 429 and quota ambiguity are not", async () => {
  for (const code of ["organization_spend_limit_exceeded", "project_spend_limit_exceeded"]) {
    expect(
      await readAiBudgetStop(
        Response.json({ error: { code, type: "insufficient_quota" } }, { status: 429 }),
        "openai",
      ),
    ).toMatchObject({
      status: "budget-exhausted",
      budget: { provider: "openai", ruleId: null, resetsAt: null },
    });
  }
  for (const code of ["rate_limit_exceeded", "insufficient_quota"]) {
    expect(
      await readAiBudgetStop(Response.json({ error: { code } }, { status: 429 }), "openai"),
    ).toBeNull();
  }
  expect(await readAiBudgetStop(new Response("not JSON", { status: 429 }), "openai")).toBeNull();
});
