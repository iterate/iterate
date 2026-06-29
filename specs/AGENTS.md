## Writing playwright tests

Think of these as _specs_ as well as tests. The idea is that a human or agent can read a test and go "I see how this aspect of the product is supposed to work now".

## Locators over `expect`

Avoid using the expect-based API for asserting that UI is visible/in a particular state. For example, don't bother with `await expect(page.getByRole("button", { name: "Run" })).toBeEnabled()` before clicking a button. Just call `await page.getByRole("button", { name: "Run" }).click()` directly. The `.click` implementation already waits for the button to exist, be visible, and to be enabled. Similarly if you want to assert that something is present on the page you can just do `await page.getByText("Welcome").waitFor()`. No need for any `await expect(...).toBeVisible()` rubbish.

Avoid using `timeout` for actions like `click`, `waitFor` etc. Read the [middlewright docs](https://github.com/iterate/middlewright) for why (TL;DR: we should have progress UI in our app rather than bumping test timeouts): `.waitFor({ timeout: 5_000 })`

Avoid doing `await myButton.waitFor()` and then `await runButton.click()`. It's another code-smell. `.click()` should _already_ wait for the button to be clickable so the `.waitFor()` is doing nothing other than give you another chance to run the test and hope for the flake gods to smile on you this time.

## Timeouts

The default `actionTimeout` in your playwright config should be _very aggressive_ and short. The `spinner-waiter` plugin allows this. If and when test fail because of this, there are two recommended courses of action, neither of which involves just bumping an assertion timeout. The first is of course to just figure out why the UI is sometimes slow and fix it. But if that's not possible, or beyond the scope of the work you're doing, the second recommended fix is to add a loading spinner to the product UI - we've identified a slow part of your app, so real users should also see a loading spinner, or some text like "Loading..."/"Pending..."/"Creating foobar..." etc.

## Error UI

For common developer pitfalls, instead of littering your test code with defensive try/catch statements and custom selectors for app error UI, just add the `data-type="error"` attribute to relevant UI elements. Then, the `ui-error-reporter` plugin will pick up any errors on screen automatically (including toasts rendered using the `sonner` library). The plugin will find elements annotated in this way and include their text content in error reports, so agents and humans will quickly be able to get an indication of what went wrong.
