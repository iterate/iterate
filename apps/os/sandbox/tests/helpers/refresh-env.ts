import type { SandboxHandle } from "../providers/types.ts";

export async function refreshEnv(sandbox: SandboxHandle): Promise<void> {
  await sandbox.exec([
    "bash",
    "-c",
    [
      'cd "${ITERATE_REPO:-/home/iterate/src/github.com/iterate/iterate}"',
      "node -e",
      JSON.stringify(
        [
          "const { createTRPCClient, httpBatchLink } = require('@trpc/client');",
          "const client = createTRPCClient({ links: [httpBatchLink({ url: 'http://localhost:3000/api/trpc' })] });",
          "client.platform.refreshEnv.mutate()",
          "  .then((res) => console.log(JSON.stringify(res)))",
          "  .catch((err) => { console.error(err); process.exit(1); });",
        ].join(" "),
      ),
    ].join(" && "),
  ]);
}
