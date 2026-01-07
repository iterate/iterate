import { test, expect } from "@playwright/test";

const TEST_OTP = "424242";

test.describe("organization creation flow", () => {
  test("should log in and create an organization", async ({ page, baseURL }) => {
    const testEmail = `test-e2e-${Date.now()}+test@example.com`;
    const timings: Record<string, number> = {};
    const time = (label: string) => {
      timings[label] = performance.now();
    };

    time("start");

    await page.goto(`${baseURL}/login`);
    await page.waitForSelector('input[type="email"]');
    time("login-page-loaded");

    await page.fill('input[type="email"]', testEmail);
    await page.click('button:has-text("Continue with Email")');
    time("otp-sent");

    await page.waitForSelector('text="Enter verification code"', { timeout: 10000 });
    time("otp-page-shown");

    const otpInputs = page.locator('input[inputmode="numeric"]');
    await otpInputs.first().click();
    for (const char of TEST_OTP) {
      await page.keyboard.type(char);
    }
    time("otp-entered");

    await page.waitForURL((url) => !url.pathname.includes("/login"), {
      timeout: 15000,
    });
    time("logged-in");

    const currentURL = page.url();
    console.log("URL after login:", currentURL);

    if (currentURL.includes("/new-organization")) {
      time("new-org-page-shown");

      await page.waitForSelector('input[id="organization-name"]');
      const orgName = `Test Org ${Date.now()}`;
      await page.fill('input[id="organization-name"]', orgName);
      time("org-name-filled");

      await page.click('button:has-text("Create organization")');
      time("create-clicked");

      await page.waitForURL(
        (url) => !url.pathname.includes("/new-organization") && !url.pathname.includes("/login"),
        { timeout: 30000 },
      );
      time("org-created");

      const finalURL = page.url();
      console.log("Final URL:", finalURL);

      expect(finalURL).not.toContain("/new-organization");
      expect(finalURL).not.toContain("/login");
    } else {
      time("already-has-org");
      expect(currentURL).not.toContain("/login");
    }

    time("end");

    console.log("\n--- Timing Report ---");
    let prev = timings["start"];
    for (const [label, timestamp] of Object.entries(timings)) {
      const delta = (timestamp - prev!).toFixed(0);
      const total = (timestamp - timings["start"]!).toFixed(0);
      console.log(`${label}: +${delta}ms (total: ${total}ms)`);
      prev = timestamp;
    }
  });

  test("should measure request timing for org creation", async ({ page, baseURL }) => {
    const testEmail = `timing-test-${Date.now()}+test@example.com`;
    const requestTimings: { url: string; duration: number; method: string }[] = [];

    page.on("requestfinished", async (request) => {
      const timing = request.timing();
      const url = request.url();
      if (
        url.includes("/api/trpc") ||
        url.includes("/api/auth") ||
        url.includes("/new-organization")
      ) {
        requestTimings.push({
          url: url.replace(baseURL!, ""),
          method: request.method(),
          duration: timing.responseEnd - timing.requestStart,
        });
      }
    });

    await page.goto(`${baseURL}/login`);
    await page.waitForSelector('input[type="email"]');
    await page.fill('input[type="email"]', testEmail);
    await page.click('button:has-text("Continue with Email")');

    await page.waitForSelector('text="Enter verification code"', { timeout: 10000 });
    const otpInputs = page.locator('input[inputmode="numeric"]');
    await otpInputs.first().click();
    for (const char of TEST_OTP) {
      await page.keyboard.type(char);
    }

    await page.waitForURL((url) => !url.pathname.includes("/login"), {
      timeout: 15000,
    });

    if (page.url().includes("/new-organization")) {
      await page.waitForSelector('input[id="organization-name"]');
      const orgName = `Timing Test Org ${Date.now()}`;
      await page.fill('input[id="organization-name"]', orgName);

      const createStart = performance.now();
      await page.click('button:has-text("Create organization")');

      await page.waitForURL(
        (url) => !url.pathname.includes("/new-organization") && !url.pathname.includes("/login"),
        { timeout: 30000 },
      );
      const createEnd = performance.now();

      console.log(`\nOrg creation took: ${(createEnd - createStart).toFixed(0)}ms`);
    }

    console.log("\n--- Network Request Timings ---");
    const sorted = requestTimings.sort((a, b) => b.duration - a.duration);
    for (const { url, method, duration } of sorted.slice(0, 10)) {
      console.log(`${method} ${url}: ${duration.toFixed(0)}ms`);
    }

    const slowRequests = requestTimings.filter((r) => r.duration > 1000);
    if (slowRequests.length > 0) {
      console.warn("\n⚠️ Slow requests (>1s):");
      for (const { url, method, duration } of slowRequests) {
        console.warn(`  ${method} ${url}: ${duration.toFixed(0)}ms`);
      }
    }
  });
});
