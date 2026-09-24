// Tests for iterate/icon-button-has-hover-text: icon-size <Button>s render no
// visible text, so they must carry an aria-label (or title) — the design
// system's Button turns the aria-label into a title attribute, giving hover
// text for free. The popular off-the-shelf rule for this
// (jsx-a11y/control-has-associated-label) deliberately assumes any
// uppercase-component child (like a lucide icon) might render a text label,
// so it never flags `<Button size="icon"><Trash /></Button>` — hence this
// custom rule.

import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

test("flags an icon-size Button with no label", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/icon-button-has-hover-text": "error" } });
  fixture.write(
    "unlabeled.tsx",
    [
      "declare const Button: any, Trash: any;",
      "export const remove = (",
      '  <Button size="icon-sm" variant="outline">',
      "    <Trash />",
      "  </Button>",
      ");",
      "",
    ].join("\n"),
  );

  const result = fixture.run(["unlabeled.tsx"], { expectFailure: true });
  expect(result.stdout + result.stderr).toMatch(/Add aria-label/);
});

test("flags all icon sizes, including in render props", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/icon-button-has-hover-text": "error" } });
  fixture.write(
    "render-prop.tsx",
    [
      "declare const Button: any, DialogClose: any, X: any;",
      "export const close = (",
      '  <DialogClose render={<Button size="icon-xs" />}>',
      "    <X />",
      "  </DialogClose>",
      ");",
      "",
    ].join("\n"),
  );

  fixture.run(["render-prop.tsx"], { expectFailure: true });
});

test("accepts aria-label, title, dynamic labels, spreads, and non-icon sizes", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/icon-button-has-hover-text": "error" } });
  fixture.write(
    "labeled.tsx",
    [
      "declare const Button: any, Trash: any, Plus: any, props: any, label: string;",
      "export const ok = (",
      "  <>",
      '    <Button size="icon-sm" aria-label="Delete row">',
      "      <Trash />",
      "    </Button>",
      '    <Button size="icon" title="Delete row">',
      "      <Trash />",
      "    </Button>",
      '    <Button size="icon-lg" aria-label={label}>',
      "      <Trash />",
      "    </Button>",
      '    <Button size="icon-sm" {...props}>',
      "      <Trash />",
      "    </Button>",
      '    <Button size="sm">',
      "      <Plus />",
      "      Connect",
      "    </Button>",
      "  </>",
      ");",
      "",
    ].join("\n"),
  );

  fixture.run(["labeled.tsx"]);
});

test("rejects an empty aria-label", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/icon-button-has-hover-text": "error" } });
  fixture.write(
    "empty-label.tsx",
    [
      "declare const Button: any, Trash: any;",
      "export const remove = (",
      '  <Button size="icon-sm" aria-label=" ">',
      "    <Trash />",
      "  </Button>",
      ");",
      "",
    ].join("\n"),
  );

  fixture.run(["empty-label.tsx"], { expectFailure: true });
});
