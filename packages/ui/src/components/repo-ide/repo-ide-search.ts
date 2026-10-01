import { z } from "zod";

/** The repo IDE's view state, the route's search so every view is a link: `file` the open path,
 *  `diff` whether the diff against the baseline shows, `preview` whether a markdown or html file
 *  shows its rendered preview instead of the editor, `scm` and `history` which sidebar shows
 *  instead of the file tree, `staged` the readonly Index view of the open file, and `commit` the
 *  expanded commit, whose diff of the open file then shows. */
export const RepoIdeSearch = z.object({
  file: z.string().optional().catch(undefined),
  diff: z.literal(true).optional().catch(undefined),
  preview: z.literal(true).optional().catch(undefined),
  scm: z.literal(true).optional().catch(undefined),
  staged: z.literal(true).optional().catch(undefined),
  history: z.literal(true).optional().catch(undefined),
  commit: z.string().optional().catch(undefined),
});
export type RepoIdeSearch = z.infer<typeof RepoIdeSearch>;
