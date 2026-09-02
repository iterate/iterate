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
        text: `@${path}`,
        icon: <FileIcon aria-hidden />,
      }));
    },
  };
}
