import { tmpdir } from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { z } from "zod";
import { x as exec } from "tinyexec";
import { fetch } from "../../../backend/fetch.ts";
import { t } from "../config.ts";
import { addUserToEstate } from "./add-to-estate.ts";

export const checkoutEstateCommand = t.procedure
  .input(
    z.object({
      estateId: z.string(),
      path: z.string().optional().default(tmpdir()),
      rmrf: z.boolean().default(false),
    }),
  )
  .mutation(async ({ input }) => {
    const repoPath = input.path;

    if (input.rmrf) {
      await fs.rm(repoPath, { recursive: true, force: true });
    }

    await fs.mkdir(path.dirname(repoPath), { recursive: true });
    const { getRepoAccessToken } = await import("../github-utils.ts");
    const {
      token,
      repoId,
      repoRef,
      repoPath: estateRepoPath,
    } = await getRepoAccessToken(input.estateId);

    if (!repoId) {
      throw new Error(`No repo is linked to estate ${input.estateId}`);
    }

    const repoNameRes = await fetch(`https://api.github.com/repositories/${repoId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "Iterate OS",
      },
    });

    if (!repoNameRes.ok) {
      throw new Error(`Failed to fetch repository name: ${repoNameRes.statusText}`);
    }
    const repoNameData = (await repoNameRes.json()) as { full_name: string };
    const repoName = repoNameData.full_name;

    console.log(`Cloning repository ${repoName} to ${repoPath}`);
    const fullCloneUrl = `https://x-access-token:${token}@github.com/${repoName}`;

    const cloneResult = await exec("git", ["clone", fullCloneUrl, repoPath]);
    if (cloneResult.exitCode !== 0) {
      throw new Error(`Failed to clone repository: ${cloneResult.stderr}`);
    }

    if (repoRef) {
      // Checkout the repository to the ref
      exec("git", ["checkout", repoRef], {
        nodeOptions: {
          cwd: repoPath,
        },
      });
    }

    return path.join(repoPath, estateRepoPath || ".");
  });

export const estate = t.router({
  checkout: checkoutEstateCommand,
  addUser: addUserToEstate,
});
