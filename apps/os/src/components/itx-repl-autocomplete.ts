import type { CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import type { Facet } from "@codemirror/state";
import type { WorkerShape } from "@valtown/codemirror-ts/worker";
import type { ItxReplTypeScriptWorker } from "./itx-repl-types.ts";

type TypeScriptWorkerFacet = Facet<
  { path: string; worker: WorkerShape },
  { path: string; worker: WorkerShape } | null
>;

export function itxReplAutocompleteWorker(tsFacetWorker: TypeScriptWorkerFacet): CompletionSource {
  return async (context): Promise<CompletionResult | null> => {
    const config = context.state.facet(tsFacetWorker);
    if (!config) return null;

    const worker = config.worker as unknown as ItxReplTypeScriptWorker;
    return worker.getAutocompletionWithDocs({
      path: config.path,
      context: {
        explicit: context.explicit,
        pos: context.pos,
      },
    });
  };
}
