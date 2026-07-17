import { expect, test } from "vitest";
import { ITX_EXAMPLES } from "../../../os/src/itx/examples.ts";
import { phoneRunnableExamples } from "./examples.ts";

test("includes project-scoped, run-script-capable examples", () => {
  const ids = phoneRunnableExamples().map((example) => example.id);
  expect(ids).toContain("egress-rules-configured");
  expect(ids).toContain("append-and-read-stream");
});

test("excludes session-context examples (no project itx to run them against)", () => {
  const ids = phoneRunnableExamples().map((example) => example.id);
  expect(ids).not.toContain("whoami");
  expect(ids).not.toContain("list-projects");
});

test("excludes live-session-only examples (not run-script-capable)", () => {
  const liveOnly = ITX_EXAMPLES.filter(
    (example) => example.context === "project" && !example.runtimes.includes("run-script"),
  );
  expect(liveOnly.length).toBeGreaterThan(0); // sanity: this case actually exists in the catalogue
  const ids = phoneRunnableExamples().map((example) => example.id);
  for (const example of liveOnly) expect(ids).not.toContain(example.id);
});

test("every returned example is project-scoped and run-script-capable", () => {
  for (const example of phoneRunnableExamples()) {
    expect(example.context).toBe("project");
    expect(example.runtimes).toContain("run-script");
  }
});
