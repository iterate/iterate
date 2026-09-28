// The Dash's project overview links the config repo (`/repos/config`) to a git remote and pulls and
// pushes its main (apps/dash/src/routes/_auth/projects/$slug/index.tsx, `itx.repos.get(path)`'s
// `setOrigin`, `pull` and `push`). A fresh project's seed and a public GitHub repository are
// unrelated histories, so the first pull finds the two mains diverged and the person picks one.
import { test } from "../test-support/test.ts";

/** Public and tiny: its `main` is three commits, fetched anonymously over https. */
const PUBLIC_REMOTE = "https://github.com/octocat/Spoon-Knife.git";

test("a project links its config repo to a public GitHub repository, replaces its diverged main with GitHub's, and linked again after unlinking is already up to date", async ({
  page,
  baseURL,
  helpers,
}) => {
  helpers.appOrigin("dash");
  await using _fixture = await helpers.createFixture("config-repo", { app: baseURL });
  const configRepo = page.getByRole("region", { name: "Config repo" });
  const sheet = page.getByRole("dialog");

  await test.step("link the public remote: the seed and GitHub's main have diverged", async () => {
    await configRepo.getByText("Not linked").waitFor();
    await configRepo.getByRole("button", { name: "Link", exact: true }).click();
    await sheet.getByRole("textbox", { name: "Git URL" }).fill(PUBLIC_REMOTE);
    await sheet.getByRole("button", { name: "Link", exact: true }).click();
    await sheet
      .getByRole("heading", { name: "GitHub's main and iterate's have diverged", exact: true })
      .waitFor();
  });

  await test.step("replace iterate's main with GitHub's", async () => {
    await sheet.getByRole("button", { name: "Replace with GitHub's main", exact: true }).click();
    // the sheet's own confirm: what goes, then Replace
    await sheet
      .getByRole("heading", { name: "Replace iterate's main with GitHub's?", exact: true })
      .waitFor();
    await sheet.getByRole("button", { name: "Replace", exact: true }).click();
    await configRepo.getByText(/^Pulled [0-9a-f]{7}$/).waitFor();
    await configRepo.getByRole("link", { name: "octocat/Spoon-Knife", exact: true }).waitFor();
  });

  await test.step("unlink, then link again: already up to date, nothing to choose", async () => {
    await configRepo.getByRole("button", { name: "Unlink", exact: true }).click();
    await configRepo.getByText("Not linked").waitFor();
    await configRepo.getByRole("button", { name: "Link", exact: true }).click();
    await sheet.getByRole("textbox", { name: "Git URL" }).fill(PUBLIC_REMOTE);
    await sheet.getByRole("button", { name: "Link", exact: true }).click();
    await configRepo.getByText("Already up to date", { exact: true }).waitFor();
    await configRepo.getByRole("link", { name: "octocat/Spoon-Knife", exact: true }).waitFor();
  });
});
