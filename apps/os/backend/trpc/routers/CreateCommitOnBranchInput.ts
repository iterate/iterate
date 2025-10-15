import { z } from "zod";

export const CreateCommitOnBranchInput = z.object({
  branch: z.object({
    repositoryNameWithOwner: z.string(),
    branchName: z.string(),
  }),
  message: z.object({ headline: z.string() }),
  fileChanges: z.object({
    additions: z.array(z.object({ path: z.string(), contents: z.string() })).optional(),
    deletions: z.array(z.object({ path: z.string() })).optional(),
  }),
  expectedHeadOid: z.string(),
});
export type CreateCommitOnBranchInput = z.infer<typeof CreateCommitOnBranchInput>;
