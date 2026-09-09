import { EditorState, StateEffect, StateField, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { MessageMentionRange } from "@iterate-com/shared/message";

type MentionFieldValue = {
  decorations: DecorationSet;
  mentions: MessageMentionRange[];
};

export const setComposerMentions = StateEffect.define<MessageMentionRange[]>();
export const addComposerMention = StateEffect.define<MessageMentionRange>();

function mentionDecorations(mentions: readonly MessageMentionRange[]): DecorationSet {
  return Decoration.set(
    mentions.map((mention) =>
      // Keep the durable display text in the document and style it as a pill.
      // A mark remains friendly to clipboard, selection, and mobile IME while
      // atomicRanges gives mention boundaries entity-like cursor behavior.
      Decoration.mark({
        class: "cm-agent-mention",
        attributes: {
          "aria-label": `File mention ${mention.mention.path}`,
          "data-mention-type": mention.mention.type,
          title: mention.mention.path,
        },
      }).range(mention.from, mention.to),
    ),
    true,
  );
}

function mentionsInDocumentOrder(mentions: readonly MessageMentionRange[]): MessageMentionRange[] {
  return mentions.toSorted(
    (left, right) =>
      left.from - right.from ||
      left.to - right.to ||
      left.mention.id.localeCompare(right.mention.id),
  );
}

function mapMentions(
  mentions: readonly MessageMentionRange[],
  transaction: Transaction,
): MessageMentionRange[] {
  if (!transaction.docChanged) return [...mentions];
  const text = transaction.newDoc.toString();
  return mentions.flatMap((mention): MessageMentionRange[] => {
    // Opposite associations keep typing at either pill boundary outside it.
    const from = transaction.changes.mapPos(mention.from, 1);
    const to = transaction.changes.mapPos(mention.to, -1);
    if (to <= from || text.slice(from, to) !== mention.display) return [];
    return [{ ...mention, from, to }];
  });
}

const mentionField = StateField.define<MentionFieldValue>({
  create: () => ({ decorations: Decoration.none, mentions: [] }),
  update(value, transaction) {
    let mentions = mapMentions(value.mentions, transaction);
    for (const effect of transaction.effects) {
      if (effect.is(setComposerMentions)) mentions = effect.value;
      if (effect.is(addComposerMention)) mentions = [...mentions, effect.value];
    }
    mentions = mentionsInDocumentOrder(mentions);
    return { decorations: mentionDecorations(mentions), mentions };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});

export const composerMentionExtension = mentionField;

export function composerMentions(state: EditorState): readonly MessageMentionRange[] {
  return state.field(mentionField).mentions;
}

export function sameComposerMentions(
  left: readonly MessageMentionRange[],
  right: readonly MessageMentionRange[],
): boolean {
  return (
    left.length === right.length &&
    left.every((mention, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        mention.from === candidate.from &&
        mention.to === candidate.to &&
        mention.display === candidate.display &&
        mention.mention.id === candidate.mention.id &&
        mention.mention.type === candidate.mention.type &&
        mention.mention.repoPath === candidate.mention.repoPath &&
        mention.mention.path === candidate.mention.path
      );
    })
  );
}

export function deleteComposerMentionAtCursor(editor: EditorView, direction: -1 | 1): boolean {
  const selection = editor.state.selection.main;
  if (!selection.empty) return false;
  const mention = composerMentions(editor.state).find((candidate) =>
    direction < 0 ? candidate.to === selection.head : candidate.from === selection.head,
  );
  if (mention === undefined) return false;
  editor.dispatch({
    changes: { from: mention.from, to: mention.to },
    selection: { anchor: mention.from },
  });
  return true;
}
