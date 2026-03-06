import dedent from "dedent";
import { expect, test } from "vitest";
import { wrapCodeWithExportDefault } from "./wrap-code.ts";

const contextKeys = ["slack", "resend", "replicate", "webchat"];
const wrap = (code: string) =>
  wrapCodeWithExportDefault(code, {
    contextKeys,
    contextType: `import("./context.ts").ExecutionContext`,
  });

test("passes through code that already has export default", () => {
  const code = `export default async ({slack}: any) => slack.chat.postMessage({})`;
  expect(wrap(code)).toBe(code);
});

test("passes through export default with newline", () => {
  const code = dedent`
    export default async () => {
      return 123
    }
  `;
  expect(wrap(code)).toBe(code);
});

test("wraps single expression without context keys", () => {
  expect(wrap(`"foo bar".split(" ")`)).toBe(`export default async () => "foo bar".split(" ")`);
});

test("wraps single expression with context key", () => {
  expect(wrap(`slack.chat.postMessage({channel: "#general", text: "hi"})`)).toBe(
    dedent`
      export default async ({slack}: import("./context.ts").ExecutionContext) => slack.chat.postMessage({channel: "#general", text: "hi"})
    `,
  );
});

test("wraps multi-statement code as block body", () => {
  expect(
    wrap(dedent`
      const words = "foo bar".split(" ");
      return words.length
    `),
  ).toBe(dedent`
    export default async () => {
      const words = "foo bar".split(" ");
      return words.length
    }
  `);
});

test("wraps multi-statement code with context keys", () => {
  expect(
    wrap(dedent`
      const result = await slack.chat.postMessage({channel: "#general", text: "hi"});
      return result.ts
    `),
  ).toBe(dedent`
    export default async ({slack}: import("./context.ts").ExecutionContext) => {
      const result = await slack.chat.postMessage({channel: "#general", text: "hi"});
      return result.ts
    }
  `);
});

test("detects multiple context keys", () => {
  expect(
    wrap(dedent`
      await slack.chat.postMessage({channel: "#general", text: "hi"});
      await resend.emails.send({from: "a", to: ["b"], subject: "c", text: "d"})
    `),
  ).toBe(dedent`
    export default async ({slack, resend}: import("./context.ts").ExecutionContext) => {
      await slack.chat.postMessage({channel: "#general", text: "hi"});
      await resend.emails.send({from: "a", to: ["b"], subject: "c", text: "d"})
    }
  `);
});

test("does not inject keys that are locally declared", () => {
  expect(
    wrap(dedent`
      const slack = {chat: {postMessage: () => {}}};
      slack.chat.postMessage({})
    `),
  ).toBe(dedent`
    export default async () => {
      const slack = {chat: {postMessage: () => {}}};
      slack.chat.postMessage({})
    }
  `);
});

test("does not inject keys used only as property names", () => {
  expect(
    wrap(dedent`
      const obj = {slack: 123};
      return obj.slack
    `),
  ).toBe(dedent`
    export default async () => {
      const obj = {slack: 123};
      return obj.slack
    }
  `);
});

test("handles await in single expression", () => {
  expect(wrap(`await fetch("https://example.com")`)).toBe(
    `export default async () => await fetch("https://example.com")`,
  );
});

test("handles template literals", () => {
  expect(wrap("`hello ${'world'}`")).toBe("export default async () => `hello ${'world'}`");
});

test("simple numeric expression", () => {
  expect(wrap("1 + 2")).toBe("export default async () => 1 + 2");
});

test("function call expression", () => {
  expect(wrap(`console.log("hi")`)).toBe(`export default async () => console.log("hi")`);
});

test("ternary expression", () => {
  expect(wrap(`true ? "a" : "b"`)).toBe(`export default async () => true ? "a" : "b"`);
});

test("if statement is multi-statement", () => {
  expect(wrap(`if (true) { return 1 }`)).toBe(dedent`
    export default async () => {
      if (true) { return 1 }
    }
  `);
});

test("webchat usage", () => {
  expect(wrap(`await webchat.postMessage({threadId: "t1", text: "hi"})`)).toBe(
    `export default async ({webchat}: import("./context.ts").ExecutionContext) => await webchat.postMessage({threadId: "t1", text: "hi"})`,
  );
});

test("preserves order of context keys", () => {
  // replicate comes before webchat in contextKeys, even though webchat appears first in code
  const result = wrap(`webchat.listThreads(); replicate.run("model", {input: {}})`);
  // contextKeys order: slack, resend, replicate, webchat
  expect(result).toContain("{replicate, webchat}");
});

test("shorthand property assignment still counts as reference", () => {
  expect(
    wrap(dedent`
      const obj = {slack};
      return obj
    `),
  ).toBe(dedent`
    export default async ({slack}: import("./context.ts").ExecutionContext) => {
      const obj = {slack};
      return obj
    }
  `);
});

test("import shadows context key", () => {
  expect(
    wrap(dedent`
      import slack from "some-module";
      slack.doStuff()
    `),
  ).toBe(dedent`
    export default async () => {
      import slack from "some-module";
      slack.doStuff()
    }
  `);
});

test("variable shadows context key", () => {
  expect(
    wrap(dedent`
      const slack = "some-string";
      return slack.slice(1, -1);
    `),
  ).toBe(dedent`
    export default async () => {
      const slack = "some-string";
      return slack.slice(1, -1);
    }
  `);
});

test("empty string becomes single expression", () => {
  const result = wrap("");
  expect(result).toMatchInlineSnapshot(`
    "export default async () => {

    }"
  `);
});

test("arrow function expression (not statement)", () => {
  expect(wrap(`(() => 42)()`)).toBe(`export default async () => (() => 42)()`);
});

test("object literal expression needs parens", () => {
  // `{a: 1}` is ambiguous (block vs object), user must write `({a: 1})`
  expect(wrap(`({a: 1, b: 2})`)).toBe(`export default async () => ({a: 1, b: 2})`);
});

test("object literal expression is a block without parens", () => {
  // `{a: 1}` is ambiguous (block vs object), user must write `({a: 1})`
  expect(wrap(`{a: 1, b: 2}`)).toMatchInlineSnapshot(`
    "export default async () => {
      {a: 1, b: 2}
    }"
  `);
});

test("for loop is multi-statement", () => {
  expect(wrap(`for (const x of [1,2,3]) { console.log(x) }`)).toBe(dedent`
    export default async () => {
      for (const x of [1,2,3]) { console.log(x) }
    }
  `);
});

test("try/catch is multi-statement with context key", () => {
  expect(wrap(`try { await slack.chat.postMessage({}) } catch(e) { return e }`)).toBe(dedent`
    export default async ({slack}: import("./context.ts").ExecutionContext) => {
      try { await slack.chat.postMessage({}) } catch(e) { return e }
    }
  `);
});

test("catch clause variable doesn't leak as context ref", () => {
  // `slack` is declared in the catch clause, so it should NOT be injected
  expect(wrap(`try { throw new Error("x") } catch(slack) { return slack.message }`)).toBe(dedent`
    export default async () => {
      try { throw new Error("x") } catch(slack) { return slack.message }
    }
  `);
});

test("falls back to any when no contextType provided", () => {
  const result = wrapCodeWithExportDefault(`slack.chat.postMessage({})`, {
    contextKeys,
  });
  expect(result).toBe(`export default async ({slack}: any) => slack.chat.postMessage({})`);
});
