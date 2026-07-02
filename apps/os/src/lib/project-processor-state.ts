import { useItxProcessorState } from "~/itx/itx-react.tsx";

/**
 * Live project processor state — the fold behind the agents/repos/secrets/
 * streams lists and the `created` lifecycle fact. Server-side, `itx.*.list()`
 * reads the same fold, so pages painting from this state show exactly what
 * the API would return, kept fresh by pushes.
 *
 * One shared cache key per project (like `projectsListQueryKey` in
 * projects-query.ts): every page on the project paints from the same entry.
 */
export function useProjectProcessorState(projectId: string) {
  return useItxProcessorState({
    key: ["project-processor", projectId],
    processor: (itx) => itx.processor,
  });
}
