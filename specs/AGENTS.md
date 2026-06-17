## Writing playwright tests

Think of these as _specs_ as well as tests. The idea is that a human or agent can read a test and go "I see how this aspect of the product is supposed to work now".

## Locators over `expect`

Avoid using the expect-based API for asserting that UI is visible/in a particular state. For example, don't bother with `await expect(page.getByRole("button", { name: "Run" })).toBeEnabled()` before clicking a button. Just call `await page.getByRole("button", { name: "Run" }).click()` directly. The `.click` implementation already waits for the button to exist, be visible, and to be enabled. Similarly if you want to assert that something is present on the page you can just do `await page.getByText("Welcome").waitFor()`. No need for any `await expect(...).toBeVisible()` rubbish.
