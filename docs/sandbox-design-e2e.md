# Rahul and Nick

- introduce concept of access tokens for iterate instances so machines can auth with our platform
- create new db table tracking "machines"
- when somebody signs up, create a new machine in daytona and give it an access token
- machine then pings our platform to say "here i am and here's the secret you can use to talk to me" - encrypt tokens with env var please
- give misha and me a helper function to send authenticated requests to the daemon running on the machine
  - fetchwrapper factory that takes instance id and gives us a fetch
- add button to UI to abandon current machine and make new one, in case one agent goes berserk
- and of course make sure the sandbox has the relevant env vars
- daemon auth middleware - maybe store credentials in home dir somewhere or something
- instance env vars take precedence over os-provided ones

Sidebar navigation of os gains

- Access tokens
- Machines
- Env vars

# Machine creation flow

1. User signs up or clicks "rebuild machine"
2. Starts create daytona machine workflow
   - Create new entry in machines table with newly minted encrypted mutual access token
   - Creates daytona machine using sandbox.create with snapshot id and env vars (including git access token, openai env var, all instance specific env vars)
   - This starts the daemon
   - Daemon says to worker workflow "here i am"
   - Workflow says to deamon: bootstrap yourself POST /platform/boostrap
     - Check out git repo to ~/workspace or whatever
     - "Ready for action"
3. Restart machine when env vars change (or create new machine)

# Misha and Jonas

Plan for pi agent integration:

Misha and Jonas to own daemon package or iterate cli

In os

- When receiving slack webhooks, forward them to the iterate instance sandbox

In daemon / pi setup MVP

- Make it so we can receive slack message
- Make it so we can send messages back to slack (either as tool calls or )

Step 2

- proxy LLM requests through worker so we don't expose our openai API keys
- Find a way to wire up our MCP stuff and context rules
- Allow 'hot reloading' of env vars

Locked in

- Agent loop is running in container!
- packages/daemon
  - /agents <- durable streams
  - /ui
  - /edge/slack
  - /platform/ping
  - /platform/bootstrap - does the git checkout etc?
  - /platform/config? - returns iterate config
-
