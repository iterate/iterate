## Writing playwright tests

Think of these as _specs_ as well as tests. The idea is that a human or agent can read a test and go "I see how this aspect of the product is supposed to work now".

## Locators over `expect`

Avoid using the expect-based API for asserting that UI is visible/in a particular state. For example, don't bother with `await expect(page.getByRole("button", { name: "Run" })).toBeEnabled()` before clicking a button. Just call `await page.getByRole("button", { name: "Run" }).click()` directly. The `.click` implementation already waits for the button to exist, be visible, and to be enabled. Similarly if you want to assert that something is present on the page you can just do `await page.getByText("Welcome").waitFor()`. No need for any `await expect(...).toBeVisible()` rubbish.

Avoid using `timeout` for actions like `click`, `waitFor` etc. Read the [middlewright docs](https://github.com/iterate/middlewright) for why (TL;DR: we should have progress UI in our app rather than bumping test timeouts): `.waitFor({ timeout: 5_000 })`

Avoid doing `await myButton.waitFor()` and then `await runButton.click()`. It's another code-smell. `.click()` should _already_ wait for the button to be clickable so the `.waitFor()` is doing nothing other than give you another chance to run the test and hope for the flake gods to smile on you this time.
