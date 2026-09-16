import { describe, expect, test } from "vitest";
import { runDelegationTurn, scriptOf } from "./delegation-turn.ts";

describe("scriptOf", () => {
  const rows: { name: string; reply: string; becomes: string | null }[] = [
    {
      name: "a ts fence is the script",
      reply: "```ts\nasync (itx) => 1\n```",
      becomes: "async (itx) => 1",
    },
    {
      name: "an untagged fence counts",
      reply: "sure\n```\nasync (itx) => 2\n```\n",
      becomes: "async (itx) => 2",
    },
    { name: "prose only is the spoken answer", reply: "Two plus two is four.", becomes: null },
    { name: "inline code is not a fence", reply: "use `itx.kv.get`", becomes: null },
  ];
  for (const row of rows) test(row.name, () => expect(scriptOf(row.reply)).toBe(row.becomes));
});

const transcript = [{ role: "listener" as const, text: "what is two plus two" }];

async function turn(replies: string[], scriptResults: string[] = []) {
  const completions: { role: string; content: string }[][] = [];
  const scripts: string[] = [];
  const notes: string[] = [];
  const result = await runDelegationTurn(transcript, {
    complete: async (messages) => {
      completions.push(messages.map((m) => ({ ...m })));
      const reply = replies.shift();
      if (!reply) throw new Error("no more replies");
      return reply;
    },
    runScript: async (script) => {
      scripts.push(script);
      return scriptResults.shift() || "null";
    },
    progress: async (note) => {
      notes.push(note);
    },
  });
  return { result, completions, scripts, notes };
}

test("a plain reply is the spoken answer", async () => {
  const { result, completions } = await turn(["Two plus two is four."]);
  expect(completions).toHaveLength(1);
  expect(completions[0]![0]!.role).toBe("system");
  expect(completions[0]!.at(-1)).toEqual({ role: "user", content: "what is two plus two" });
  expect(result).toEqual({ content: "Two plus two is four.", hangUp: false, scripts: 0 });
});

test("a fenced script runs, its result is fed back, and the next plain reply is spoken", async () => {
  const { result, scripts, notes, completions } = await turn(
    ["```ts\nasync (itx) => (await itx.kv.list()).keys.length\n```", "There are three keys."],
    ["3"],
  );
  expect(scripts).toEqual(["async (itx) => (await itx.kv.list()).keys.length"]);
  expect(notes).toEqual(["Backend step 1: running a script for the request."]);
  expect(completions[1]!.at(-1)).toEqual({ role: "user", content: "Script result:\n3" });
  expect(result).toEqual({ content: "There are three keys.", hangUp: false, scripts: 1 });
});

test("a goodbye with the hang-up token hangs up without saying the token", async () => {
  const { result } = await turn(["Bye for now. HANG_UP"]);
  expect(result).toEqual({ content: "Bye for now.", hangUp: true, scripts: 0 });
});

test("a model failure is spoken, not thrown", async () => {
  const { result } = await turn([]);
  expect(result.content).toMatch(/^Sorry, that did not work: no more replies/);
  expect(result.hangUp).toBe(false);
});
