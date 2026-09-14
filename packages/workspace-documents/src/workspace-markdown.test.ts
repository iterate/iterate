import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { expect, test } from "vitest";
import { workspaceMarkdown } from "./workspace-markdown.ts";
import { projectedMarkdown } from "./rfm-projected-markdown.ts";

test.for(["ts", "typescript", "TS", "tsx"])(
  "%s fences parse TypeScript in source and rich views",
  (info) => {
    const code = "const count: number = 42;";
    const fence = `\`\`\`${info}\n${code}\n\`\`\`\n`;
    for (const language of [workspaceMarkdown(), projectedMarkdown()]) {
      // Frontmatter forces the rich parser to map code tokens back to source offsets.
      const doc = `---\ntitle: Example\n---\n\n${fence}`;
      const state = EditorState.create({ doc, extensions: language });
      const tree = ensureSyntaxTree(state, doc.length, 1000)!;
      const type = tree.resolveInner(doc.indexOf("number") + 1);
      expect(type.name).toBe("TypeName");
      expect(doc.slice(type.from, type.to)).toBe("number");
    }
  },
);

test("an unknown fence stays editable as plain code", () => {
  const doc = "```unknown\nconst count: number = 42;\n```";
  const state = EditorState.create({ doc, extensions: workspaceMarkdown() });
  const tree = ensureSyntaxTree(state, doc.length, 1000)!;
  expect(tree.resolveInner(doc.indexOf("number") + 1).name).toBe("CodeText");
});
