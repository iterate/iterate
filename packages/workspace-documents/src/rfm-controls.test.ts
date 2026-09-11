import { Annotation, EditorState, StateEffect, StateField, Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { applyReviewOperation, readReview } from "iterate/document-review";
import { rfmControlRanges, rfmInputFilter } from "./rfm-controls.ts";

const source = [
  "---",
  "title: Review",
  "---",
  "",
  'A {==one==}{>>root<<}{id="c1" by="Jonas" at="2026-09-08T10:00:00.000Z"}{>>reply<<}{id="c2" by="AI" at="2026-09-08T10:01:00.000Z" re="c1"} B {>>loose<<}{id="c3" by="AI" at="2026-09-08T10:02:00.000Z"}.',
  "",
  'A {++new++}{id="s1" by="AI" at="2026-09-08T10:03:00.000Z"}.',
  "",
  "---",
  "comments:",
  "  c1:",
  "    by: Jonas",
  '    at: "2026-09-08T10:00:00.000Z"',
  "  c2:",
  "    by: AI",
  '    at: "2026-09-08T10:01:00.000Z"',
  "    re: c1",
  "  c3:",
  "    by: AI",
  '    at: "2026-09-08T10:02:00.000Z"',
  "  s1:",
  "    by: AI",
  '    at: "2026-09-08T10:03:00.000Z"',
  "",
].join("\n");

function range(kind: ReturnType<typeof rfmControlRanges>[number]["kind"]) {
  const result = rfmControlRanges(readReview(source), source.length).find(
    (candidate) => candidate.kind === kind,
  );
  if (!result) throw new Error(`Missing ${kind} control in fixture`);
  return result;
}

describe("rfmControlRanges", () => {
  it("covers every projected-away source range with absolute positions", () => {
    const ranges = rfmControlRanges(readReview(source), source.length);

    expect(ranges.map((range) => range.kind)).toEqual(
      expect.arrayContaining(["frontmatter", "endmatter", "open", "suffix", "hidden", "atomic"]),
    );
    for (const [index, control] of ranges.entries()) {
      expect(source.slice(control.from, control.to)).not.toBe("");
      expect(control.from).toBeGreaterThanOrEqual(index === 0 ? 0 : ranges[index - 1]!.to);
    }
    expect(ranges.some((control) => source.slice(control.from, control.to).includes("loose"))).toBe(
      true,
    );
    expect(ranges.some((control) => source.slice(control.from, control.to).includes("new"))).toBe(
      true,
    );
  });

  it("returns no controls for malformed review source", () => {
    expect(rfmControlRanges(readReview("{==broken"), "{==broken".length)).toEqual([]);
  });
});

describe("rfmInputFilter", () => {
  const state = () => EditorState.create({ doc: source, extensions: rfmInputFilter() });

  it("redirects atomic suffix Backspace to the preceding visible grapheme", () => {
    const suffix = range("suffix");
    const next = state().update({
      changes: { from: suffix.from, to: suffix.to },
      annotations: Transaction.userEvent.of("delete.backward"),
    }).state;

    expect(next.doc.toString()).toBe(source.replace("{==one==}", "{==on==}"));
    expect(next.selection.main.head).toBe(suffix.from - 1);
  });

  it("preserves controls while replacing a selection that crosses them", () => {
    const suffix = range("suffix");
    const start = source.indexOf("one") + 1;
    const next = state().update({ changes: { from: start, to: suffix.to + 2, insert: "X" } }).state;

    expect(next.doc.toString()).toBe(source.replace("{==one==}", "{==oX==}").replace(" B ", " "));
  });

  it("keeps annotations and effects when it rewrites input", () => {
    const suffix = range("suffix");
    const marker = Annotation.define<string>();
    const effect = StateEffect.define<string>();
    const received = StateField.define({
      create: () => "",
      update: (value, transaction) =>
        transaction.effects.find((candidate) => candidate.is(effect))?.value ?? value,
    });
    const next = EditorState.create({
      doc: source,
      extensions: [rfmInputFilter(), received],
    }).update({
      changes: { from: suffix.from, to: suffix.to },
      annotations: [Transaction.userEvent.of("delete.backward"), marker.of("kept")],
      effects: effect.of("kept"),
      scrollIntoView: true,
    });

    expect(next.annotation(marker)).toBe("kept");
    expect(next.state.field(received)).toBe("kept");
    expect(next.scrollIntoView).toBe(true);
  });

  it("maps positional effects through the rewritten change", () => {
    const suffix = range("suffix");
    const position = StateEffect.define<number>({
      map: (value, changes) => changes.mapPos(value),
    });
    const received = StateField.define({
      create: () => -1,
      update: (value, transaction) =>
        transaction.effects.find((candidate) => candidate.is(position))?.value ?? value,
    });
    const next = EditorState.create({
      doc: source,
      extensions: [rfmInputFilter(), received],
    }).update({
      changes: { from: suffix.from, to: suffix.to },
      annotations: Transaction.userEvent.of("delete.backward"),
      effects: position.of(suffix.from),
    }).state;

    expect(next.field(received)).toBe(suffix.from - 1);
  });

  it("normalizes a programmatic caret inside hidden source", () => {
    const suffix = range("suffix");
    const next = state().update({ selection: { anchor: suffix.from + 1 } }).state;

    expect(next.selection.main.head).toBe(suffix.from);
  });

  it("snaps an opening-control caret into anchor text for consecutive native input", () => {
    const open = range("open");
    let next = state().update({ selection: { anchor: open.from + 1 } }).state;

    expect(next.selection.main.head).toBe(open.to);
    for (const text of ["Z", "Q"]) {
      const position = next.selection.main.head;
      next = next.update({
        changes: { from: position, insert: text },
        selection: { anchor: position + text.length },
        annotations: Transaction.userEvent.of("input.type"),
      }).state;
    }

    expect(next.doc.toString()).toBe(source.replace("{==one==}", "{==ZQone==}"));
  });

  it("normalizes a rewritten caret against the changed document", () => {
    const suffix = range("suffix");
    const start = source.indexOf("one") + 1;
    const inserted = "123456";
    const next = state().update({
      changes: { from: start, to: suffix.to + 2, insert: inserted },
    }).state;

    expect(next.selection.main.head).toBe(start + inserted.length);
  });

  it("keeps Ctrl+A then ArrowRight typing before endmatter", () => {
    const footer = rfmControlRanges(readReview(source), source.length).find(
      (control) => control.kind === "endmatter" && control.to === source.length,
    );
    if (!footer) throw new Error("Missing endmatter in fixture");
    let next = state().update({ selection: { anchor: 0, head: source.length } }).state;
    next = next.update({ selection: { anchor: source.length } }).state;

    expect(next.selection.main.head).toBe(footer.from);
    next = next.update({
      changes: { from: next.selection.main.head, insert: "Typed\n" },
      selection: { anchor: next.selection.main.head + 6 },
      annotations: Transaction.userEvent.of("input.type"),
    }).state;

    expect(next.doc.toString()).toBe(
      source.slice(0, footer.from) + "Typed\n" + source.slice(footer.from),
    );
  });

  it("keeps empty-body document-comment typing before its endmatter", () => {
    const applied = applyReviewOperation("", {
      type: "add-document-comment",
      body: "Review this document.",
      author: "Jonas",
    });
    if (!applied.ok) throw new Error(applied.message);
    const documentComment = applied.source;
    const footer = rfmControlRanges(readReview(documentComment), documentComment.length).find(
      (control) => control.kind === "endmatter" && control.to === documentComment.length,
    );
    if (!footer) throw new Error("Missing document-comment endmatter");
    let next = EditorState.create({ doc: documentComment, extensions: rfmInputFilter() });
    next = next.update({ selection: { anchor: documentComment.length } }).state;
    next = next.update({
      changes: { from: next.selection.main.head, insert: "Body\n" },
      selection: { anchor: 5 },
      annotations: Transaction.userEvent.of("input.type"),
    }).state;

    expect(next.doc.toString()).toBe(
      documentComment.slice(0, footer.from) + "Body\n" + documentComment.slice(footer.from),
    );
    expect(readReview(next.doc.toString()).diagnostics).toEqual([]);
  });

  it("keeps frontmatter-only typing after the frontmatter", () => {
    const frontmatterOnly = "---\nowner: Alice\n---\n";
    let next = EditorState.create({ doc: frontmatterOnly, extensions: rfmInputFilter() });
    next = next.update({ selection: { anchor: 0 } }).state;
    next = next.update({
      changes: { from: next.selection.main.head, insert: "B" },
      selection: { anchor: frontmatterOnly.length + 1 },
      annotations: Transaction.userEvent.of("input.type"),
    }).state;

    expect(next.doc.toString()).toBe(frontmatterOnly + "B");
    expect(readReview(next.doc.toString()).diagnostics).toEqual([]);
  });

  it("does not block an authoritative source transform", () => {
    const next = state().update({
      changes: { from: 0, to: source.length, insert: "plain" },
      filter: false,
    }).state;

    expect(next.doc.toString()).toBe("plain");
  });

  it("rewrites a normal multi-change transaction without throwing", () => {
    const suffix = range("suffix");
    const next = state().update({
      changes: [
        { from: 0, insert: "X" },
        { from: suffix.from, to: suffix.to },
      ],
      annotations: Transaction.userEvent.of("delete.backward"),
    }).state;

    const bodyStart = readReview(source).body.range.start;
    const expected = source.replace("{==one==}", "{==on==}");
    expect(next.doc.toString()).toBe(
      expected.slice(0, bodyStart) + "X" + expected.slice(bodyStart),
    );
  });
});
