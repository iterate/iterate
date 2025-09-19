# iterate

## get started

```bash
pnpm install
brew install doppler
doppler login
doppler setup # choose project `os` and config `dev_personal`
pnpm docker:up # requires docker
pnpm db:migrate
pnpm dev
```

To connect slack, you'll need to set the callback url in your app manifest.

Open the URL printed out by `pnpm dev`, login, then click "Connect Slack" and you'll get an error page with the callback URL you need to add. Then go to https://api.slack.com/apps, click your app, then click "App Manifest" on the sidebar. Then paste the redirect URL from the error page into the manifest. You can then try again and you should be able to connect slack and talk to your bot.