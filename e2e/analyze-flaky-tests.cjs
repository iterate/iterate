const fs = require("fs");

const resultsFile = process.argv[2] || "e2e-results.json";
const outputFile = process.argv[3] || "flaky-report.md";

let results;
try {
  const jsonContent = fs.readFileSync(resultsFile, "utf8");
  const lines = jsonContent.split("\n");
  const jsonLine = lines.find((l) => l.startsWith("{"));
  results = jsonLine ? JSON.parse(jsonLine) : null;
} catch (err) {
  console.log("Failed to parse e2e results:", err.message);
  fs.writeFileSync(
    outputFile,
    "# Flaky Test Detection Report\n\nNo results to analyze (JSON parse failed).\n",
  );
  process.exit(0);
}

if (!results || !results.suites) {
  console.log("No test suites found in results");
  fs.writeFileSync(
    outputFile,
    "# Flaky Test Detection Report\n\nNo test suites found in results.\n",
  );
  process.exit(0);
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

const flakyTests = [];
for (const [, stats] of testStats) {
  if (stats.total > 0) {
    const passRate = (stats.passed / stats.total) * 100;
    if (passRate < 90) {
      flakyTests.push({ ...stats, passRate: passRate.toFixed(1) });
    }
  }
}

let report = "# Flaky Test Detection Report\n\n";
report += "Tests run 10 times each. Flaky = <90% pass rate.\n\n";

if (flakyTests.length === 0) {
  report += "## No flaky tests detected!\n\nAll tests passed at least 90% of the time.\n";
} else {
  report += "## Flaky Tests Detected\n\n";
  report += "| File | Test | Pass Rate | Passed | Failed |\n";
  report += "|------|------|-----------|--------|--------|\n";
  for (const test of flakyTests.sort((a, b) => parseFloat(a.passRate) - parseFloat(b.passRate))) {
    report +=
      "| " +
      test.file +
      " | " +
      test.name +
      " | " +
      test.passRate +
      "% | " +
      test.passed +
      "/" +
      test.total +
      " | " +
      test.failed +
      " |\n";
  }
}

console.log(report);
fs.writeFileSync(outputFile, report);

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) {
  fs.appendFileSync(summaryFile, report);
}

if (flakyTests.length > 0) {
  console.log("::warning::Found " + flakyTests.length + " flaky test(s)");
}
