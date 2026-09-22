import { expect, test } from "vitest";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "../../src/agent/system-prompt.ts";
import { runDelegationTurn } from "./delegation-turn.ts";

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
  expect(completions[0]![0]!.content).toMatch(
    `${DEFAULT_AGENT_SYSTEM_PROMPT}\nINSTRUCTIONS FOR SPOKEN CONVERSATIONS:`,
  );
  expect(completions[0]!.at(-1)).toEqual({ role: "user", content: "what is two plus two" });
  expect(result).toEqual({ content: "Two plus two is four.", hangUp: false, scripts: 0 });
});

test("the normal prompt's repository example runs and its result reaches the next turn", async () => {
  const { result, scripts, notes, completions } = await turn(
    [
      '<codemode status="Reading the website">\nreturn await itx.repos.get("/repos/config").readFile("worker.ts")\n</codemode>',
      "The website says hello.",
    ],
    ['"hello"'],
  );
  expect(scripts).toEqual([
    'async (itx) => {\nreturn await itx.repos.get("/repos/config").readFile("worker.ts")\n}',
  ]);
  expect(notes).toEqual(["Reading the website"]);
  expect(completions[1]!.at(-1)).toEqual({ role: "user", content: 'Script result:\n"hello"' });
  expect(result).toEqual({ content: "The website says hello.", hangUp: false, scripts: 1 });
});

test.each([
  "<codemode>\nreturn 1",
  "<codemode>\nreturn 1\n</codemode>\n<codemode>\nreturn 2\n</codemode>",
])("invalid codemode executes nothing and the model can correct it: %s", async (invalid) => {
  const { result, scripts, completions } = await turn(
    [invalid, "<codemode>\nreturn 3\n</codemode>", "Three."],
    ["3"],
  );
  expect(scripts).toEqual(["async (itx) => {\nreturn 3\n}"]);
  expect(completions[1]!.at(-1)?.content).toMatch(/NOT run|NOTHING was executed/);
  expect(result).toEqual({ content: "Three.", hangUp: false, scripts: 1 });
});

test("a speculative failure beside the clock script is not spoken before its successful result", async () => {
  const { result, notes } = await turn(
    [
      '<codemode status="Checking London time">\nreturn new Intl.DateTimeFormat("en-GB", {timeZone:"Europe/London",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date());\n</codemode>\n\nI couldn’t verify the current time in London.',
      "The current time in London is 12:00.",
    ],
    ['"12:00"'],
  );
  expect(notes).toEqual(["Checking London time"]);
  expect(result.content).toBe("The current time in London is 12:00.");
});

test("the script bound reports unfinished work instead of claiming success", async () => {
  const { result, scripts } = await turn(Array(7).fill("<codemode>\nreturn 1\n</codemode>"));
  expect(scripts).toHaveLength(6);
  expect(result).toEqual({
    content: "I couldn't finish the request within the allowed number of steps.",
    hangUp: false,
    scripts: 6,
  });
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
