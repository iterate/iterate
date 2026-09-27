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
import { lintOne } from "./oxlint-fixture.ts";

test.for([
  {
    name: "flags an icon-size Button with no title",
    source: `
      declare const Button: any, Trash: any;
      export const remove = (
        <Button size="icon-sm" variant="outline">
          <Trash />
        </Button>
      );
    `,
    reports: ['<Button size="icon-sm">'],
  },
  {
    name: "flags an aria-label without a title: the Button no longer turns it into hover text",
    source: `
      declare const Button: any, Trash: any;
      export const remove = (
        <Button size="icon-sm" aria-label="Delete row">
          <Trash />
        </Button>
      );
    `,
    reports: ['<Button size="icon-sm">'],
  },
  {
    name: "flags all icon sizes, including in render props",
    source: `
      declare const Button: any, DialogClose: any, X: any;
      export const close = (
        <DialogClose render={<Button size="icon-xs" />}>
          <X />
        </DialogClose>
      );
    `,
    reports: ['<Button size="icon-xs">'],
  },
  {
    name: "accepts a title, a title beside an aria-label, dynamic titles, spreads, and non-icon sizes",
    source: `
      declare const Button: any, Trash: any, Plus: any, props: any, label: string;
      export const ok = (
        <>
          <Button size="icon" title="Delete row">
            <Trash />
          </Button>
          <Button size="icon-sm" aria-label="Delete row" title="Delete row">
            <Trash />
          </Button>
          <Button size="icon-lg" title={label}>
            <Trash />
          </Button>
          <Button size="icon-sm" {...props}>
            <Trash />
          </Button>
          <Button size="sm">
            <Plus />
            Connect
          </Button>
        </>
      );
    `,
    reports: [],
  },
  {
    name: "rejects an empty title",
    source: `
      declare const Button: any, Trash: any;
      export const remove = (
        <Button size="icon-sm" title=" ">
          <Trash />
        </Button>
      );
    `,
    reports: ['<Button size="icon-sm">'],
  },
  {
    name: "treats SidebarTrigger as the icon-size Button it renders",
    source: `
      declare const SidebarTrigger: any;
      export const toggle = <SidebarTrigger className="md:hidden" />;
    `,
    reports: ['<SidebarTrigger size="icon-sm">'],
  },
  {
    name: "accepts a SidebarTrigger with a title",
    source: `
      declare const SidebarTrigger: any;
      export const toggle = <SidebarTrigger className="md:hidden" title="Toggle sidebar" />;
    `,
    reports: [],
  },
])("$name", ({ source, reports }) => {
  const { messages } = lintOne("icon-button-has-hover-text", "input.tsx", source);
  expect(messages).toEqual(
    reports.map((element) =>
      expect.stringContaining(`An icon-only ${element} has no visible text`),
    ),
  );
});
