import * as fs from "fs";
import { defineConfig } from "vitest/config";
import EvaliteReporter from "evalite/reporter";
import { type Evalite } from "evalite/types";
import betterSqlite3 from "better-sqlite3";
import type { RunnerTask, RunnerTestCase } from "vitest";

fs.mkdirSync("ignoreme", { recursive: true });
const db = betterSqlite3("ignoreme/eval.db");

type MethodInputs = {
  [K in keyof EvaliteReporter]: EvaliteReporter[K] extends (...args: any) => any
    ? Parameters<EvaliteReporter[K]>
    : never;
};
type EvaliteRunnerTestCase = Omit<RunnerTestCase, "meta"> & {
  meta: { evalite: { result: Evalite.Result; duration: number } };
};
class MyEvaliteReporter extends EvaliteReporter {
  override reportTestSummary(...args: MethodInputs["reportTestSummary"]): void {
    console.log("reportTestSummary", args);
    const flattenSuiteTasks = (task: RunnerTask): Exclude<RunnerTask, { type: "suite" }>[] => {
      if (task.type !== "suite") return [task];
      return task.tasks.flatMap(flattenSuiteTasks);
    };
    const flatTasks = args[0].flatMap((test) =>
      test.tasks.flatMap(flattenSuiteTasks),
    ) as EvaliteRunnerTestCase[];
    console.dir(
      flatTasks.map((task) => ({
        name: task.name,
        type: task.type,
        path: "filepath" in task ? String(task.filepath).replace(process.cwd() + "/", "") : null,
        evalName: task.meta.evalite.result.evalName,
        duration: task.meta.evalite.duration,
        input: task.meta.evalite.result.input,
        expect: task.meta.evalite.result.expected,
        output: task.meta.evalite.result.output,
        scores: task.meta.evalite.result.scores,
      })),
      { depth: null },
    );
    super.reportTestSummary(...args);
    // console.dir(summary, { depth: null });
  }
  // private renderTable(table: TableRow[]): void {
  //   super.renderTable(table);
  //   console.dir({ table }, { depth: null });
  // }
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.eval.ts"],
    provide: { cwd: process.cwd() },
    testTimeout: 30_000,
    reporters: [
      new MyEvaliteReporter({
        logNewState: () => {},
        port: 7001,
        isWatching: false,
        db: db,
        scoreThreshold: 60,
        modifyExitCode: () => {},
      }),
    ],
  },
});
