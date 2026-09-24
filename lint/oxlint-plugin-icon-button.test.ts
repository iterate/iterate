// Tests for iterate/icon-button-has-hover-text: icon-size <Button>s render no
// visible text, so they must carry a title at the call site. It is their hover
// text, and their accessible name when there is no aria-label. The vendored
// shadcn Button (packages/ui/AGENTS.md) passes title through and derives
// nothing, so an aria-label alone no longer gives hover text. The popular
// off-the-shelf rule for this (jsx-a11y/control-has-associated-label)
// deliberately assumes any uppercase-component child (like a lucide icon) might
// render a text label, so it never flags `<Button size="icon"><Trash /></Button>`
// — hence this custom rule.

import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

test("flags an icon-size Button with no title", () => {
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
  expect(result.stdout + result.stderr).toMatch(/Add title/);
});

test("flags an aria-label without a title: the Button no longer turns it into hover text", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/icon-button-has-hover-text": "error" } });
  fixture.write(
    "aria-label-only.tsx",
    [
      "declare const Button: any, Trash: any;",
      "export const remove = (",
      '  <Button size="icon-sm" aria-label="Delete row">',
      "    <Trash />",
      "  </Button>",
      ");",
      "",
    ].join("\n"),
  );

  fixture.run(["aria-label-only.tsx"], { expectFailure: true });
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

test("accepts a title, a title beside an aria-label, dynamic titles, spreads, and non-icon sizes", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/icon-button-has-hover-text": "error" } });
  fixture.write(
    "labeled.tsx",
    [
      "declare const Button: any, Trash: any, Plus: any, props: any, label: string;",
      "export const ok = (",
      "  <>",
      '    <Button size="icon" title="Delete row">',
      "      <Trash />",
      "    </Button>",
      '    <Button size="icon-sm" aria-label="Delete row" title="Delete row">',
      "      <Trash />",
      "    </Button>",
      '    <Button size="icon-lg" title={label}>',
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

test("rejects an empty title", () => {
  using fixture = createOxlintFixture({ rules: { "iterate/icon-button-has-hover-text": "error" } });
  fixture.write(
    "empty-title.tsx",
    [
      "declare const Button: any, Trash: any;",
      "export const remove = (",
      '  <Button size="icon-sm" title=" ">',
      "    <Trash />",
      "  </Button>",
      ");",
      "",
    ].join("\n"),
  );

  fixture.run(["empty-title.tsx"], { expectFailure: true });
});
