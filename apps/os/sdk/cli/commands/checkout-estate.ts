import { tmpdir } from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { z } from "zod";
import { x as exec } from "tinyexec";
import { EstateSpecifierFromString } from "../estate-specifier.ts";
import { t } from "../config.ts";

export const checkoutEstateCommand = t.procedure
  .input(
    z.object({
      estate: EstateSpecifierFromString.meta({ alias: "e" }),
      path: z.string().optional(),
      rmrf: z.boolean().optional(),
    }),
  )
  .mutation(async ({ input }) => {
    const repoPath =
      input.path ||
      path.join(
        tmpdir(),
        `iterate/${input.estate.owner}/${input.estate.repo}/${Date.now()}/${input.estate.repo}`,
      );
    if (input.rmrf) {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
    await fs.mkdir(path.dirname(repoPath), { recursive: true });
    const cloneResult = await exec("git", ["clone", input.estate.cloneUrl, repoPath]);
    if (cloneResult.exitCode !== 0) {
      throw new Error(`Failed to clone repository: ${cloneResult.stderr}`);
    }
    return repoPath;
  });
