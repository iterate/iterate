## How to run e2e tests locally

### Github Installation ID, Github PAT

for iterate-estate org, you don't need to change it, keep it as it is

### Slack Team ID and Target Channel

The default one points to our iterate slack workspace, and slack-e2e-test channel, this is fine for local testing.
You just need to make sure your `(local $USER) iterate` bot, and you are added to that channel.

### User Access Token for your local user, with `chat:write` scope

You already have access to Niterate Bot, which is setup with the scopes
Go to this link, <https://api.slack.com/apps/A095Q8D83QS/oauth>
Reinstall to Iterate, and you will see the User OAuth token (starts with `xoxp-`), copy that and put in the `slack.user.accessToken` field.

### Your user id

Open <https://iterate-com.slack.com>, mention yourself, then open dev tools, inspect the mention, it should have your user id (starts with `U`).
put it in the `slack.user.id` field.

### Bot Access Token

Open the bot settings for your local bot, go to the same `OAuth & Permissions` tab, re install it, you will see the Bot Access Token (starts with `xoxb-`), copy that and put in the `slack.bot.accessToken` field.
This will also give you a user access token, but it doesn't have all the scopes, so don't need to worry about that.

### Bot user id

Same as how you got your user id, mention your bot, find the user id, put it in the `slack.bot.id` field.

Once all of the above is setup, you can run the e2e tests locally by running `pnpm test:e2e`

## How E2E tests work in CI (prod & preview)

In CI, the setup is mostly same, but done on a separate Slack Dev Workspace as we are using the production bot.
The Dev workspace and the user who is testing is `iterate@nustom.com`, if you need to access that workspace, you can login with that user to google and access the dev workspace, passwords are in 1password.
