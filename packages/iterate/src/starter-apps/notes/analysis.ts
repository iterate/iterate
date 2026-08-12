// The analysis half the NotesApp worker injects as the processor's `analyze`
// dep: one Workers AI text call over the note's raw text returning
// {title, tags}. Parse defensively — an unparseable answer degrades to an
// empty title and ["untagged"] so failures stay visible in the list rather
// than throwing the obligation into a retry loop.
import { NOTES_ANALYSIS_MODEL, type NotesAnalysis } from "./processor.ts";

export async function analyzeNoteText(
  ai: { run: (model: string, body: Record<string, unknown>) => Promise<unknown> },
  input: { text: string },
): Promise<NotesAnalysis> {
  const answer: any = await ai.run(NOTES_ANALYSIS_MODEL, {
    messages: [{ role: "user", content: `${notesAnalysisPrompt()}\n\nNote:\n${input.text}` }],
    max_tokens: 256,
  });
  const text =
    typeof answer?.response === "string"
      ? answer.response
      : typeof answer?.choices?.[0]?.message?.content === "string"
        ? answer.choices[0].message.content
        : "";
  let title = "";
  let tags = ["untagged"];
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed.title === "string") title = parsed.title.trim().slice(0, 120);
      if (Array.isArray(parsed.tags)) {
        tags = [
          ...new Set<string>(
            parsed.tags
              .filter((tag: unknown): tag is string => typeof tag === "string")
              .map((tag: string) =>
                tag
                  .toLowerCase()
                  .trim()
                  .replace(/[^a-z0-9-]+/g, "-")
                  .replace(/^-+|-+$/g, ""),
              )
              .filter((tag: string) => tag.length > 0 && tag.length <= 30),
          ),
        ].slice(0, 4);
      }
    } catch {}
  }
  return { title, tags, processedBy: NOTES_ANALYSIS_MODEL };
}

function notesAnalysisPrompt(): string {
  return [
    'Reply with ONLY a JSON object: {"title": string, "tags": string[]}.',
    "title: ONE line saying what the note is about, specific not generic — 'Standing desk: 76cm' " +
      "never 'A note' or 'User's thoughts'. Reuse the note's own words where possible.",
    "tags: up to 4 kebab-case topical tags (e.g. idea, todo, reference, shopping). " +
      "Fewer is better; an empty array is a fine answer.",
  ].join("\n");
}
