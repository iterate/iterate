import * as fs from "fs";
import { defineConfig } from "vitest/config";
import EvaliteReporter from "evalite/reporter";
import betterSqlite3 from "better-sqlite3";
import type { ad } from "vitest/dist/chunks/reporters.d.BFLkQcL6.js";

fs.mkdirSync("ignoreme", { recursive: true });
const db = betterSqlite3("ignoreme/eval.db");

class MyEvaliteReporter extends EvaliteReporter {
  onTestSuiteResult(testSuite: ad): void {
    super.onTestSuiteResult(testSuite);
    console.log(testSuite);
  }
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
