import dedent from "dedent";

export const workerCrons = {
  /** every minute */
  processOutboxQueue: "0-59/1 * * * *",
} as const;

const uniqueCrons = new Set(Object.values(workerCrons));
if (uniqueCrons.size !== Object.values(workerCrons).length) {
  const msg = dedent`
    Duplicate cron expressions found in workerCrons: ${Object.values(workerCrons).join("\n")}

    This is banned because it makes it harder to write type-safe, obviously-correct switch statements etc.
    if you need two minute-ly crons, just use arbitrary differences like \`*/1 * * * *\` and \`0-59/1 * * * *\`
  `;
  throw new Error(msg);
}

export type WorkerCrons = typeof workerCrons;
export type WorkerCronName = keyof WorkerCrons;
export type WorkerCronExpression = WorkerCrons[WorkerCronName];
