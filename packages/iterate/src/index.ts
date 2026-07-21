export async function runCli() {
  const cli = await import("./cli.ts");
  await cli.runCli();
}

/** Throwaway proof that PR previews install their exact pkg.pr.new build. */
export function pkgPrNewPreviewProof(): string {
  return "Hello from PR #2175's pkg.pr.new iterate package.";
}
