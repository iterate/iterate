import { z } from "zod";

export const EstateSpecifier = z.object({
  raw: z.string(),
  protocol: z.string(),
  cloneUrl: z.string(),
  owner: z.string(),
  repo: z.string(),
  ref: z.string().optional(),
  directory: z.string().optional(),
});
export type EstateSpecifier = z.infer<typeof EstateSpecifier>;
export const EstateSpecifierFromString = z
  .string()
  .transform((specifier, ctx) => {
    try {
      return parseSpecifier(specifier);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: `Couldn't parse estate specifier: ${e}`, path: [] });
      return z.never();
    }
  })
  .pipe(EstateSpecifier);

export const parseSpecifier = (specifier: string): EstateSpecifier => {
  const url = new URL(specifier);
  if (url.protocol === "https:" && url.hostname === "github.com") {
    // ok this looks like a github https url, that's fine
  } else if (url.protocol !== "git:" && url.protocol !== "github:") {
    throw new Error(`Invalid protocol: ${url.protocol}. Only git: and github: are supported.`);
  }
  const ownerAndRepo = url.pathname
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^\//, "")
    .replace(/\.git$/, "")
    .split("/");
  if (ownerAndRepo.length !== 2) {
    throw new Error(`Invalid owner and repo: ${url.pathname}. Expected format: owner/repo.`);
  }
  const [owner, repo] = ownerAndRepo;

  const [ref, ...modifierParts] = url.hash?.replace(/^#/, "").split("&") ?? [];
  const modifiers = new Map(modifierParts.map((part) => part.split(":") as [string, string]));

  const cloneUrl = `https://github.com/${owner}/${repo}`;

  return {
    raw: specifier,
    protocol: url.protocol,
    cloneUrl,
    owner,
    repo,
    ref: ref || undefined,
    directory: modifiers.get("path"),
  };
};
