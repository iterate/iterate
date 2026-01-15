const fs = require("fs");

const resultsFile = process.argv[2] || "spec-results.json";
const outputFile = process.argv[3] || "flaky-report.md";

const content = fs.readFileSync(resultsFile, "utf8");
const results = JSON.parse(content);

if (!results?.suites) {
  throw new Error("No test suites found in results");
}

const testStats = new Map();

function processSpec(spec) {
  const testName = spec.title;
  const file = spec.file || "unknown";
  const key = file + "::" + testName;

  if (!testStats.has(key)) {
    testStats.set(key, { file, name: testName, passed: 0, failed: 0, total: 0 });
  }

  const stats = testStats.get(key);
  for (const test of spec.tests || []) {
    for (const result of test.results || []) {
      stats.total++;
      if (result.status === "passed" || result.status === "expected") {
        stats.passed++;
      } else {
        stats.failed++;
      }
    }
  }
}

function processSuite(suite) {
  for (const spec of suite.specs || []) {
    processSpec(spec);
  }
  for (const child of suite.suites || []) {
    processSuite(child);
  }
}

for (const suite of results.suites || []) {
  processSuite(suite);
}

const allTests = [];
let totalRuns = 0;
let totalPassed = 0;
for (const [, stats] of testStats) {
  if (stats.total > 0) {
    totalRuns += stats.total;
    totalPassed += stats.passed;
    const passRate = (stats.passed / stats.total) * 100;
    allTests.push({ ...stats, passRate });
  }
}

const flakyCount = allTests.filter((t) => t.passRate < 100).length;
const repeatCount = allTests.length > 0 ? Math.round(totalRuns / allTests.length) : 0;

let report = "# Flaky Test Detection Report\n\n";
report += "## Summary\n\n";
report += `- **${allTests.length}** unique tests\n`;
report += `- **${repeatCount}x** repeats each\n`;
report += `- **${totalRuns}** total runs\n`;
report += `- **${totalPassed}/${totalRuns}** passed (${totalRuns > 0 ? ((totalPassed / totalRuns) * 100).toFixed(1) : 0}%)\n`;
report += `- **${flakyCount}** flaky tests (<100% pass rate)\n\n`;

report += "## Results\n\n";
report += "| File | Test | Pass Rate | Passed | Failed |\n";
report += "|------|------|-----------|--------|--------|\n";
for (const test of allTests.sort(
  (a, b) => a.passRate - b.passRate || a.file.localeCompare(b.file),
)) {
  const icon = test.passRate === 100 ? "\u2705" : "\u274c";
  report +=
    "| " +
    test.file +
    " | " +
    test.name +
    " | " +
    icon +
    " " +
    test.passRate.toFixed(0) +
    "% | " +
    test.passed +
    "/" +
    test.total +
    " | " +
    test.failed +
    " |\n";
}

console.log(report);
fs.writeFileSync(outputFile, report);

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) {
  fs.appendFileSync(summaryFile, report);
}

if (flakyCount > 0) {
  console.log("::warning::Found " + flakyCount + " flaky test(s)");
}
