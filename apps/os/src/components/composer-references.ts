import { EditorState, StateEffect, StateField, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { MessageReferenceRange } from "@iterate-com/shared/message";

type ReferenceFieldValue = {
  decorations: DecorationSet;
  references: MessageReferenceRange[];
};

export const setComposerReferences = StateEffect.define<MessageReferenceRange[]>();
export const addComposerReference = StateEffect.define<MessageReferenceRange>();

function referenceDecorations(references: readonly MessageReferenceRange[]): DecorationSet {
  return Decoration.set(
    references.map((reference) =>
      // Keep the durable display text in the document and style it as a pill.
      // A mark remains friendly to clipboard, selection, and mobile IME while
      // atomicRanges gives reference boundaries entity-like cursor behavior.
      Decoration.mark({
        class: "cm-agent-reference",
        attributes: {
          "aria-label": `File reference ${reference.reference.path}`,
          "data-reference-type": reference.reference.type,
          title: reference.reference.path,
        },
      }).range(reference.from, reference.to),
    ),
    true,
  );
}

function referencesInDocumentOrder(
  references: readonly MessageReferenceRange[],
): MessageReferenceRange[] {
  return references.toSorted(
    (left, right) =>
      left.from - right.from ||
      left.to - right.to ||
      left.reference.id.localeCompare(right.reference.id),
  );
}

function mapReferences(
  references: readonly MessageReferenceRange[],
  transaction: Transaction,
): MessageReferenceRange[] {
  if (!transaction.docChanged) return [...references];
  const text = transaction.newDoc.toString();
  return references.flatMap((reference): MessageReferenceRange[] => {
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

export function composerReferences(state: EditorState): readonly MessageReferenceRange[] {
  return state.field(referenceField).references;
}

export function sameComposerReferences(
  left: readonly MessageReferenceRange[],
  right: readonly MessageReferenceRange[],
): boolean {
  return (
    left.length === right.length &&
    left.every((reference, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        reference.from === candidate.from &&
        reference.to === candidate.to &&
        reference.display === candidate.display &&
        reference.reference.id === candidate.reference.id &&
        reference.reference.type === candidate.reference.type &&
        reference.reference.repoPath === candidate.reference.repoPath &&
        reference.reference.path === candidate.reference.path
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
