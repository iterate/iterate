// The posts scripts/ci/notify.ts makes: which channel each goes to and what it says. A page to
// #error-pulse mentions Jonas and Misha; a routine post to #ci mentions nobody.
import { expect, test } from "vitest";
import { deployMessage, formatPullRequestUpdateMessage, workflowFailureMessage } from "./notify.ts";

const deploy = {
  app: "OS",
  commitSha: "0123456789abcdef",
  runUrl: "https://depot.dev/run",
  publicUrl: "https://os.iterate.com",
};

test.for([
  {
    name: "a prd deploy that succeeded is routine, in #ci",
    message: deployMessage({ ...deploy, status: "success" }),
    expected: {
      channel: "C0B3QJSU32A",
      text: "✅ OS prd deploy succeeded (0123456) · <https://os.iterate.com|Open app> · <https://depot.dev/run|View workflow run>",
    },
  },
  {
    name: "a failed prd deploy pages #error-pulse",
    message: deployMessage({ ...deploy, status: "failure" }),
    expected: {
      channel: "C09K1CTN4M7",
      text: "🚨 OS prd deploy failed (0123456) <@U067G4QRFK2> <@U099JH9TAF2>\n<https://depot.dev/run|View workflow run>",
    },
  },
  {
    name: "a failed workflow pages #error-pulse with its failed jobs",
    message: workflowFailureMessage({
      needs: { build: { result: "success" }, sweep: { result: "failure" } },
      refName: "main",
      runUrl: "https://depot.dev/run",
    }),
    expected: {
      channel: "C09K1CTN4M7",
      text: "🚨 sweep failed on main <@U067G4QRFK2> <@U099JH9TAF2>\n<https://depot.dev/run|View Workflow Run>",
    },
  },
])("$name", ({ message, expected }) => {
  // exact: a stray mention on a routine post, or a missing one on a page, must fail
  expect(message).toEqual(expected);
});

test("a pull request event's post mentions nobody", () => {
  expect(
    formatPullRequestUpdateMessage({
      action: "opened",
      sender: { login: "mmkal" },
      pull_request: {
        number: 7,
        title: "A change",
        html_url: "https://github.com/iterate/iterate/pull/7",
        user: { login: "mmkal" },
      },
    }),
  ).toBe("🟢 PR opened: <https://github.com/iterate/iterate/pull/7|#7 A change> by mmkal");
});
