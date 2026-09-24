// A secret on screen or in a field stays out of PostHog: its element carries the class posthog-js
// hands rrweb as `blockClass` and that autocapture skips. posthog-replay.test.tsx runs posthog-js on
// these components.
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { NOT_RECORDED_CLASS, NotRecorded, SecretInput, SecretTextarea } from "./not-recorded.tsx";

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

test("a SecretInput and a SecretTextarea carry the class, are never spellchecked, and keep the caller's autocomplete", () => {
  expect(
    attributes(
      renderToStaticMarkup(
        <SecretInput type="password" autoComplete="current-password" className="h-11" />,
      ),
    ),
  ).toMatchObject({
    type: "password",
    autoComplete: "current-password",
    spellCheck: "false",
    class: expect.stringMatching(/ ph-no-capture h-11$/),
  });
  expect(attributes(renderToStaticMarkup(<SecretTextarea rows={4} />))).toMatchObject({
    autoComplete: "off",
    spellCheck: "false",
    class: expect.stringMatching(/ ph-no-capture$/),
  });
});

function attributes(markup: string) {
  return Object.fromEntries(
    [...markup.matchAll(/ ([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]),
  );
}
