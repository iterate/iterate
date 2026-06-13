/**
 * Artifact token cleaning, in its own module so light consumers (the agent
 * worker) can use it without bundling the artifacts/git stack —
 * artifacts.ts drags @cloudflare/shell into any worker that value-imports
 * it.
 */
export function stripArtifactTokenQuery(token: string) {
  return token.split("?expires=")[0] ?? token;
}
