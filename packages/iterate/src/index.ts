export async function runCli() {
  const cli = await import("./cli.ts");
  await cli.runCli();
}
