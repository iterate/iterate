import { expect, test } from "vitest";
import { roundTripProblems, withDependencies } from "./shadcn-registry.ts";

test("an item's imports become its packages and registry items: shadcn's by name, ours as @iterate/<item>", () => {
  const registry = withDependencies(
    registryOf({
      "app-shell": ["src/components/app-shell.tsx", "src/components/app-shell-palette.tsx"],
      "iterate-logo": ["src/components/iterate-logo.tsx", "src/components/iterate-logo.svg"],
      "plain-left-click": ["src/lib/plain-left-click.ts"],
    }),
    new Map([
      [
        "src/components/app-shell.tsx",
        `import { useState } from "react";
import type { Principal } from "iterate/principal";
import { AppShellPalette } from "./app-shell-palette.tsx";
import { plainLeftClick } from "#/lib/plain-left-click.ts";
import { Sidebar } from "#/components/ui/sidebar.tsx";
import { IterateLogo } from "#/components/iterate-logo.tsx";
export const loadEditor = () => import("@codemirror/view");`,
      ],
      ["src/components/app-shell-palette.tsx", `export { Command } from "cmdk";`],
      ["src/components/iterate-logo.tsx", `import logo from "./iterate-logo.svg";`],
      ["src/components/iterate-logo.svg", "<svg />"],
      ["src/components/ui/sidebar.tsx", "export const Sidebar = 1"],
      ["src/lib/plain-left-click.ts", "export const plainLeftClick = () => true;"],
    ]),
  );
  expect(registry).toMatchObject({
    items: [
      {
        name: "app-shell",
        type: "registry:component",
        description: "app-shell",
        dependencies: ["@codemirror/view", "cmdk", "iterate"],
        registryDependencies: ["@iterate/iterate-logo", "@iterate/plain-left-click", "sidebar"],
        files: [
          { path: "src/components/app-shell.tsx", type: "registry:component" },
          { path: "src/components/app-shell-palette.tsx", type: "registry:component" },
        ],
      },
      {
        name: "iterate-logo",
        type: "registry:component",
        description: "iterate-logo",
        files: [
          { path: "src/components/iterate-logo.tsx", type: "registry:component" },
          { path: "src/components/iterate-logo.svg", type: "registry:component" },
        ],
      },
      {
        name: "plain-left-click",
        type: "registry:lib",
        description: "plain-left-click",
        files: [{ path: "src/lib/plain-left-click.ts", type: "registry:lib" }],
      },
    ],
  });
});

// What an app installing the item could not resolve, or a file the registry would not serve.
test.for<{
  name: string;
  items: Record<string, string[]>;
  source: Record<string, string>;
  problem: string;
}>([
  {
    name: "a relative import of another item's file",
    items: { a: ["src/components/a.tsx"], b: ["src/components/b.tsx"] },
    source: { "src/components/a.tsx": `import "./b.tsx";`, "src/components/b.tsx": "" },
    problem: "src/components/a.tsx: ./b.tsx is b's, not a's: import it as #/components/b.tsx",
  },
  {
    name: "a #/ import of the item's own file",
    items: { a: ["src/components/a.tsx", "src/components/a-part.tsx"] },
    source: {
      "src/components/a.tsx": `import "#/components/a-part.tsx";`,
      "src/components/a-part.tsx": "",
    },
    problem: "src/components/a.tsx: #/components/a-part.tsx is a's own: import it relatively",
  },
  {
    name: "a #/ import of a file no item serves",
    items: { a: ["src/components/a.tsx"] },
    source: {
      "src/components/a.tsx": `import "#/hooks/use-thing.ts";`,
      "src/hooks/use-thing.ts": "",
    },
    problem:
      "src/components/a.tsx: #/hooks/use-thing.ts is in no item, so an app installing a lacks it",
  },
  {
    name: "a private workspace package",
    items: { a: ["src/components/a.tsx"] },
    source: { "src/components/a.tsx": `import "@iterate-com/shared/posthog";` },
    problem:
      "src/components/a.tsx: @iterate-com/shared/posthog is a private workspace package, which an app outside the monorepo cannot install",
  },
  {
    name: "an import of a file that does not exist",
    items: { a: ["src/components/a.tsx"] },
    source: { "src/components/a.tsx": `import "#/components/ui/kbd.tsx";` },
    problem: "src/components/a.tsx: #/components/ui/kbd.tsx does not exist",
  },
  {
    name: "a listed file that does not exist",
    items: { a: ["src/components/a.tsx"] },
    source: {},
    problem: "a: src/components/a.tsx does not exist",
  },
  {
    name: "a file in two items",
    items: { a: ["src/components/a.tsx"], b: ["src/components/a.tsx"] },
    source: { "src/components/a.tsx": "" },
    problem: "src/components/a.tsx is in both a and b",
  },
  {
    name: "a component no item lists",
    items: {},
    source: { "src/components/stray.tsx": "", "src/components/stray.test.tsx": "" },
    problem: "src/components/stray.tsx is in no item: add it to one in registry.json",
  },
])("throws on $name", ({ items, source, problem }) => {
  expect(() => withDependencies(registryOf(items), new Map(Object.entries(source)))).toThrow(
    `\n- ${problem}`,
  );
});

test("the round trip lets the CLI drop a file's leading comment (shadcn-ui/ui#9206) and nothing else", () => {
  const current = new Map([
    ["packages/ui/src/components/a.tsx", "// header\n/** doc */\nexport const a = 1; // kept\n"],
    ["packages/ui/src/components/b.tsx", "export const b = 1;\n"],
    ["packages/ui/src/components/c.tsx", "export const c = 1;\n"],
    ["packages/ui/src/components/logo.svg", "<!-- kept --><svg />\n"],
  ]);
  expect(
    roundTripProblems({
      files: [...current.keys()],
      written: [
        { path: "packages/ui/src/components/a.tsx", content: "export const a = 1; // kept\n" },
        { path: "packages/ui/src/components/b.tsx", content: "export const b = 2;\n" },
        { path: "packages/ui/src/components/logo.svg", content: "<svg />\n" },
        { path: "packages/ui/src/components/ui/button.tsx", content: '"use client"\n' },
      ],
      current: (path) => current.get(path)!,
    }),
  ).toEqual([
    "packages/ui/src/components/b.tsx (differs)",
    "packages/ui/src/components/c.tsx (not written)",
    "packages/ui/src/components/logo.svg (differs)",
  ]);
});

/** A registry of `items` (name to file paths), each described by its name. */
function registryOf(items: Record<string, string[]>) {
  return {
    $schema: "https://ui.shadcn.com/schema/registry.json",
    name: "iterate",
    homepage: "https://github.com/iterate/packages",
    items: Object.entries(items).map(([name, files]) => ({
      name,
      description: name,
      files: files.map((path) => ({ path })),
    })),
  };
}
