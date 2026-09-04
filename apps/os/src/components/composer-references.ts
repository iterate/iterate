import { EditorState, StateEffect, StateField, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { AgentRichContentReferenceRange } from "@iterate-com/shared/agent-rich-content";

type ReferenceFieldValue = {
  decorations: DecorationSet;
  references: AgentRichContentReferenceRange[];
};

export const setComposerReferences = StateEffect.define<AgentRichContentReferenceRange[]>();
export const addComposerReference = StateEffect.define<AgentRichContentReferenceRange>();

function referenceDecorations(
  references: readonly AgentRichContentReferenceRange[],
): DecorationSet {
  return Decoration.set(
    references.map((reference) =>
      // Keep the durable display text in the document and style it as a pill.
      // A mark remains friendly to clipboard, selection, and mobile IME while
      // atomicRanges gives reference boundaries entity-like cursor behavior.
      Decoration.mark({
        class: "cm-agent-reference",
        attributes: {
          "aria-label": `File reference ${reference.target.path}`,
          "data-reference-kind": reference.target.kind,
          title: reference.target.path,
        },
      }).range(reference.from, reference.to),
    ),
    true,
  );
}

function referencesInDocumentOrder(
  references: readonly AgentRichContentReferenceRange[],
): AgentRichContentReferenceRange[] {
  return references.toSorted(
    (left, right) =>
      left.from - right.from ||
      left.to - right.to ||
      left.occurrenceId.localeCompare(right.occurrenceId),
  );
}

function mapReferences(
  references: readonly AgentRichContentReferenceRange[],
  transaction: Transaction,
): AgentRichContentReferenceRange[] {
  if (!transaction.docChanged) return [...references];
  const text = transaction.newDoc.toString();
  return references.flatMap((reference): AgentRichContentReferenceRange[] => {
    // Opposite associations keep typing at either pill boundary outside it.
    const from = transaction.changes.mapPos(reference.from, 1);
    const to = transaction.changes.mapPos(reference.to, -1);
    if (to <= from || text.slice(from, to) !== reference.display) return [];
    return [{ ...reference, from, to }];
  });
}

const referenceField = StateField.define<ReferenceFieldValue>({
  create: () => ({ decorations: Decoration.none, references: [] }),
  update(value, transaction) {
    let references = mapReferences(value.references, transaction);
    for (const effect of transaction.effects) {
      if (effect.is(setComposerReferences)) references = effect.value;
      if (effect.is(addComposerReference)) references = [...references, effect.value];
    }
    references = referencesInDocumentOrder(references);
    return { decorations: referenceDecorations(references), references };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});

export const composerReferenceExtension = referenceField;

export function composerReferences(state: EditorState): readonly AgentRichContentReferenceRange[] {
  return state.field(referenceField).references;
}

export function sameComposerReferences(
  left: readonly AgentRichContentReferenceRange[],
  right: readonly AgentRichContentReferenceRange[],
): boolean {
  return (
    left.length === right.length &&
    left.every((reference, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        reference.from === candidate.from &&
        reference.to === candidate.to &&
        reference.occurrenceId === candidate.occurrenceId &&
        reference.display === candidate.display &&
        reference.target.kind === candidate.target.kind &&
        reference.target.repoPath === candidate.target.repoPath &&
        reference.target.path === candidate.target.path
      );
    })
  );
}

export function deleteComposerReferenceAtCursor(editor: EditorView, direction: -1 | 1): boolean {
  const selection = editor.state.selection.main;
  if (!selection.empty) return false;
  const reference = composerReferences(editor.state).find((candidate) =>
    direction < 0 ? candidate.to === selection.head : candidate.from === selection.head,
  );
  if (reference === undefined) return false;
  editor.dispatch({
    changes: { from: reference.from, to: reference.to },
    selection: { anchor: reference.from },
  });
  return true;
}
