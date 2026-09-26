// Throwaway file proving the userspace AI linter on prd; its pull request is closed unmerged.
export function parsePort(value: unknown) {
  const retries: number = 3;
  return { port: value as number, retries };
}
