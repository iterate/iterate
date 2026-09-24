// A secret on screen stays out of PostHog: its block carries the class posthog-js hands rrweb as
// `blockClass` and that autocapture skips.
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { NOT_RECORDED_CLASS, NotRecorded } from "./not-recorded.tsx";

test("a NotRecorded block carries PostHog's no-capture class beside its own, around its content", () => {
  expect(NOT_RECORDED_CLASS).toBe("ph-no-capture");
  expect(
    renderToStaticMarkup(
      <NotRecorded role="status" data-testid="minted" className="flex gap-2">
        <code>itk_secret</code>
      </NotRecorded>,
    ),
  ).toBe(
    '<div role="status" data-testid="minted" class="ph-no-capture flex gap-2"><code>itk_secret</code></div>',
  );
});
