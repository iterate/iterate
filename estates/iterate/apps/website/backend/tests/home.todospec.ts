import { test, expect } from "@playwright/test";

test("loads and has title", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Iterate");
});

test("paginates investors", async ({ page }) => {
  await page.goto("/");

  const countInvestors = async (prev: number) => {
    expect(await page.locator("#investors :not(.hidden)").count()).toBeGreaterThan(prev);
    return page.locator("#investors > :not(.hidden)").count();
  };

  let n = await countInvestors(0);
  await page.getByTestId("more-investors").click();
  n = await countInvestors(n);
  await page.getByTestId("more-investors").click();
  n = await countInvestors(n);
});

test("submits email", async ({ page }) => {
  await page.route("https://hooks.zapier.com/hooks/catch/18102796/30obtkd/", async (route) => {
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await page.locator("input[name=email]").scrollIntoViewIfNeeded();
  await page.locator("input[name=email]").fill("test@example.com");
  await page.locator("input[type=email]").press("Enter");
  await expect(
    page.getByText("We'll keep you up to date as things progress.", { exact: true })
  ).toBeInViewport();
  await expect(page.locator("input[name=email]")).toHaveValue("");
});

test("shows email error message", async ({ page }) => {
  await page.route("https://hooks.zapier.com/hooks/catch/18102796/30obtkd/", async (route) => {
    await route.fulfill({ status: 500, json: {} });
  });

  await page.goto("/");
  await page.locator("input[name=email]").scrollIntoViewIfNeeded();
  await page.locator("input[name=email]").fill("test@example.com");
  await page.locator("input[type=email]").press("Enter");
  await expect(
    page.getByText("We hit an error adding you to the waiting list. Please try again.", {
      exact: true
    })
  ).toBeInViewport();
  await expect(page.locator("input[name=email]")).toHaveValue("test@example.com"); // shouldn't clear
});

test("redirects to tally form to collect consultancy info", async ({ page }) => {
  await page.route("https://hooks.zapier.com/hooks/catch/18102796/30obtkd/", async (route) => {
    await route.fulfill({ json: {} });
  });

  await page.goto("/");
  await page.locator("input[name=email]").scrollIntoViewIfNeeded();
  await page.getByText("I want to hire you as a software consultancy").click();
  await page.locator("input[name=email]").fill("test@example.com");
  await page.locator('form button[type=submit]:text("Next →")').click();
  await page.waitForURL("https://tally.so/r/waB2RE?email=test%40example.com");
});
