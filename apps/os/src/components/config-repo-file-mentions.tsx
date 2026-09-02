import { FileIcon } from "lucide-react";
import { connectItx } from "iterate/sdk/itx/react";
import type { ComposerSuggestionProvider } from "~/components/composer-suggestions.ts";

/** The config repo adapter for the composer's generic triggered-suggestions interface. */
export function configRepoFileMentionProvider(projectId: string): ComposerSuggestionProvider {
  return {
    id: "config-repo-files",
    trigger: "@",
    label: "Config repo files",
    cacheKey: [projectId, "/repos/config"],
    search: async (query) => {
      const files = await (await connectItx(projectId)).repo.searchFiles({ query });
      return files.paths.map((path) => ({
        id: path,
        label: path,
        completion: {
          type: "reference" as const,
          display: `@${path}`,
          target: {
            kind: "config-repo-file" as const,
            repoPath: "/repos/config" as const,
            path,
          },
        },
        icon: <FileIcon aria-hidden />,
      }));
    },
  };
}
