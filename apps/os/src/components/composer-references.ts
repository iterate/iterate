import { EditorState, StateEffect, StateField, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { AgentMessageAttachmentRange } from "@iterate-com/shared/agent-message-attachments";

type ReferenceFieldValue = {
  decorations: DecorationSet;
  references: AgentMessageAttachmentRange[];
};

export const setComposerReferences = StateEffect.define<AgentMessageAttachmentRange[]>();
export const addComposerReference = StateEffect.define<AgentMessageAttachmentRange>();

function referenceDecorations(references: readonly AgentMessageAttachmentRange[]): DecorationSet {
  return Decoration.set(
    references.map((reference) =>
      // Keep the durable display text in the document and style it as a pill.
      // A mark remains friendly to clipboard, selection, and mobile IME while
      // atomicRanges gives reference boundaries entity-like cursor behavior.
      Decoration.mark({
        class: "cm-agent-reference",
        attributes: {
          "aria-label": `File attachment ${reference.attachment.path}`,
          "data-attachment-type": reference.attachment.type,
          title: reference.attachment.path,
        },
      }).range(reference.from, reference.to),
    ),
    true,
  );
}

function referencesInDocumentOrder(
  references: readonly AgentMessageAttachmentRange[],
): AgentMessageAttachmentRange[] {
  return references.toSorted(
    (left, right) =>
      left.from - right.from ||
      left.to - right.to ||
      left.attachment.id.localeCompare(right.attachment.id),
  );
}

function mapReferences(
  references: readonly AgentMessageAttachmentRange[],
  transaction: Transaction,
): AgentMessageAttachmentRange[] {
  if (!transaction.docChanged) return [...references];
  const text = transaction.newDoc.toString();
  return references.flatMap((reference): AgentMessageAttachmentRange[] => {
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

export function composerReferences(state: EditorState): readonly AgentMessageAttachmentRange[] {
  return state.field(referenceField).references;
}

export function sameComposerReferences(
  left: readonly AgentMessageAttachmentRange[],
  right: readonly AgentMessageAttachmentRange[],
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
        reference.attachment.id === candidate.attachment.id &&
        reference.attachment.type === candidate.attachment.type &&
        reference.attachment.repoPath === candidate.attachment.repoPath &&
        reference.attachment.path === candidate.attachment.path
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
