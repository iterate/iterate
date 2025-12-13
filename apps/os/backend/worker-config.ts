export const workerCrons = {
  /* every day at midnight */
  slackSync: "0 0 * * *",

  /** every minute */
  processOutboxQueue: "0-59/1 * * * *",
} as const;

const uniqueCrons = new Set(Object.values(workerCrons));
if (uniqueCrons.size !== Object.values(workerCrons).length) {
  // duplicate expressions just make it harder to write obviously-correct switch statements etc.
  // if you need two minute-ly crons, just use arbitrary differences like `*/1 * * * *` and `0-59/1 * * * *`
  // or name them differently to encompass both purposes like `processSystemTasksAndAlsoEmailGrandma`
  throw new Error("Duplicate cron expressions found in workerCrons");
}

export type WorkerCrons = typeof workerCrons;
export type WorkerCronName = keyof WorkerCrons;
export type WorkerCronExpression = WorkerCrons[WorkerCronName];
