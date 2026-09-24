// `posthogPrivacy()` (not-recorded.tsx) is PostHog's privacy in every app: each place that starts
// posthog-js spreads it last, so no option after it can loosen replay masking or drop
// `before_send`, and no other source sets those options. posthog-replay.test.tsx runs posthog-js
// with these options; this test keeps them the only ones.
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

test("every place that starts posthog-js spreads posthogPrivacy() last, and nothing else sets replay or before_send options", () => {
  const root = join(import.meta.dirname, "../../../..");
  const sources = globSync("{apps,packages}/*/src/**/*.{ts,tsx}", { cwd: root })
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));

  const starts = sources.filter(({ text }) =>
    /import\(\s*"posthog-js"\s*\)|^import (?!type )[^;]*from "posthog-js"/m.test(text),
  );
  expect(starts.map(({ file }) => file).toSorted()).toEqual([
    "apps/os/src/routes/__root.tsx",
    "packages/ui/src/components/posthog.tsx",
  ]);
  for (const { file, text } of starts)
    expect(text, `${file} spreads posthogPrivacy() as its last option`).toMatch(
      /\.\.\.posthogPrivacy\(\),\s*\}/,
    );

  expect(
    sources
      .filter(({ text }) =>
        /\b(session_recording|before_send|maskAllInputs|maskInputOptions|maskInputFn|maskTextSelector|maskTextFn|blockClass|blockSelector|ignoreClass|maskCapturedNetworkRequestFn|maskNetworkRequestFn|recordHeaders|recordBody)\s*:/.test(
          text,
        ),
      )
      .map(({ file }) => file),
  ).toEqual(["packages/ui/src/components/not-recorded.tsx"]);
});
