import {
  closeCompletion,
  pickedCompletion,
  startCompletion,
  type Completion,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { QueryClient } from "@tanstack/react-query";
import { agentMessageAttachmentId } from "@iterate-com/shared/agent-message-attachments";
import { isItxTransportError } from "iterate/sdk/itx/react";
import { addComposerReference } from "~/components/composer-references.ts";
import {
  activeComposerSuggestion,
  composerSuggestionEdit,
  type ActiveComposerSuggestion,
  type ComposerSuggestion,
  type ComposerSuggestionProvider,
} from "~/components/composer-suggestions.ts";

export function composerCompletionSource({
  getProviders,
  queryClient,
}: {
  getProviders: () => readonly ComposerSuggestionProvider[];
  queryClient: QueryClient;
}): CompletionSource {
  return async (context): Promise<CompletionResult | null> => {
    if (!context.state.selection.main.empty) return null;
    const active = activeComposerSuggestion(
      context.state.doc.toString(),
      context.pos,
      getProviders(),
    );
    if (active === null) return null;

    try {
      const queryKey = composerSuggestionQueryKey(active);
      const suggestions = await queryClient.fetchQuery({
        queryKey,
        queryFn: () => active.provider.search(active.query),
        staleTime: 30_000,
        retry: (failureCount, error) => isItxTransportError(error) && failureCount < 3,
      });
      return {
        from: active.from,
        to: active.to,
        filter: false,
        options: suggestions.map((suggestion) => completion(active, suggestion)),
      };
    } catch (error) {
      return failedCompletion(active, error, queryClient);
    }
  };
}

function completion(active: ActiveComposerSuggestion, suggestion: ComposerSuggestion): Completion {
  return {
    label: suggestion.label,
    detail: suggestion.description,
    section: active.provider.label,
    type: suggestion.type,
    apply: (view, picked, from, to) => {
      const edit = composerSuggestionEdit(view.state.doc.toString(), from, to, suggestion);
      view.dispatch({
        changes: { from, to, insert: edit.insert },
        selection: { anchor: edit.caret },
        annotations: pickedCompletion.of(picked),
        effects:
          edit.attachment === undefined
            ? []
            : [
                addComposerReference.of({
                  ...edit.attachment,
                  attachment: {
                    id: agentMessageAttachmentId(edit.attachment.target),
                    ...edit.attachment.target,
                  },
                }),
              ],
      });
    },
  };
}

function failedCompletion(
  active: ActiveComposerSuggestion,
  error: unknown,
  queryClient: QueryClient,
): CompletionResult {
  const message = error instanceof Error ? error.message : "Unknown error";
  const completion: Completion = {
    label: `Couldn’t load ${active.provider.label.toLocaleLowerCase()}`,
    detail: `${message} · select to retry`,
    type: "keyword",
    apply: (view, picked) => {
      queryClient.removeQueries({ queryKey: composerSuggestionQueryKey(active), exact: true });
      view.dispatch({ annotations: pickedCompletion.of(picked) });
      closeCompletion(view);
      globalThis.setTimeout(() => startCompletion(view), 0);
    },
  };
  return {
    from: active.from,
    to: active.to,
    filter: false,
    options: [completion],
  };
}

function composerSuggestionQueryKey(active: ActiveComposerSuggestion) {
  return [
    "composer-suggestions",
    active.provider.id,
    ...active.provider.cacheKey,
    active.query,
  ] as const;
}
