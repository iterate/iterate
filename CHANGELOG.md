# Changelog

Recent changes from the last month.

## 2025-10-14

- 880c76c update website
- 6693b2e fix: use browser version of fflate to better support workers (#344)
- e54c663 fix: don't use this reference in logger (#345)
- dd1dfec delete redundant slack stuff from old versions, better handling of files attached to messages (and sending them to channel) (#342)
- 641ff1f get rid of "input" event schemas (#335)
- f426cfc feat: add JSON logger back (#276)
- 007b416 Stop having to type agentCoreState (#343)
- 1c1e66d Make a shared helper to consolidate joining a new thread and joining part-way. (#330)
- a71be06 Google calendar authentication fixes (#341)
- c92a459 chore(deps): bump the minor-and-patch group with 33 updates (#336)
- 914cf61 fixed mcp connect (#323)
- 5bd4e8f MCP OAuth button (#281)
- 999a2b5 mock interactivity endpoint (#331)

## 2025-10-13

- 8de0536 slight rule tweaks (#333)
- e794f96 hotfix for bad DO migration (#334)
- 04c0094 refactor: route agent stub helpers centrally (#312)
- 0d42c2b use impersonateUserId instead of userId as prop name in google tools (#306)
- d8fb0c5 chore: Wrap waitUntil with error logging (#328)
- 45a2769 omg spelled his name wrong AGAIN (#329)
- a7d5dcc Add timeout to clear Slack typing status (#317)
- d13c68c chore: Add posthog to client side errors (#326)
- 84f3477 fix: Don't log out auth errors for missing cookies (#327)
- c163980 Agent labels, Context matchers on labels, and Dynamically activate gmail/gcalendar (#324)
- af5bcb7 Always take full screenshot of page (#325)
- 89e6ad5 internal bot sync, better members UI (#300)
- 10ff5e4 fix typo in Carlos Gonzales-Cadenas' name (#319)
- 0f03c13 ci: Deploy posthog injected sourcemaps (#321)
- b3ca5b1 chore: Enable cron for e2e test (#320)
- 2c10291 test: End to end onboarding test (#303)

## 2025-10-12

- fcb5a03 Add iterate config sheet to estate repo page (#316)
- 847b538 Update Stripe customer name after org rename (#313)
- ec9fd01 Restyle onboarding Slack handoff (#315)
- 3f0c6b2 feat: personalize default estate name (#314)

## 2025-10-11

- a6e68aa better status indicator (#304)

## 2025-10-10

- 7ed43be pass through thread broadcast message subtype (#302)
- 88200de Update rules everywhere (#301)
- 2f23d99 improve slack channel matching (#299)
- c672981 delete ownerless estates (only) (#295)
- 989a077 Highlight current user in org list (#290)
- 3e3300a feat: Allow shorthand jsonata expressions in context rules (#292)
- 16732f3 Refactor: Remove unused useEstateUrl hook and update links (#298)
- ce074f6 Refactor: Disable websocket connection indicator (#294)
- f54363d fix: Ellipsize long User ID on settings page for mobile (#288)
- bb5978d fix: Use useRouteLoaderData instead of outletContext (#291)
- 575d31a Add agent power user features behind debug flag (#284)
- 964fb93 fix: Create new org if external member (#287)

## 2025-10-09

- 8de26ec fix: Correctly apply filter to redirect check (#286)
- f8055a4 refactor: Centralize estate listing logic (#285)
- b0787b7 perf: Improve data loading in dashboard (#283)
- 3b958e5 more UI tidying (#282)
- aa31360 feat: inline delete user helper in user router (#279)
- 43adba1 chore: clean up our various frontend pages (#280)
- 018baaf reconnect quick fix (#277)
- 432a159 chore: Better logs for errors in github (#278)
- c1bfbfd docs: Add repository structure overview (#265)
- 34fe41f guest AND external are not allowed to call mcp or google api (#270)
- 5e4c6dd slight tidy of onboarding (#275)
- 83ba7fb cron-based slack sync (#274)
- 50f8a62 Add delete user confirmation dialog to user settings (#271)
- afcc667 Revert "feat: JSON logger with metadata (#255)" (#269)
- 2a62278 feat: JSON logger with metadata (#255)
- fbc4f1b dialog with sync results, no background sync (#267)
- 82957f4 chore: Add info section to readme (#266)

## 2025-10-08

- 73e5675 better onboarding (#252)
- 3e9907f Use slack channel name in slack matcher for #agents-with-sandboxes in iterate estate (#264)
- 16d6f25 external users, slack rules (#247)
- e3534fb Update all references to iterate-com/iterate (#263)
- 185c394 feat: gmail+calendar integration (#229)
- 8f8179b revert: Revert docker separate build (#262)
- e0b1105 ci: Separate docker built into separate action (#259)
- eb232d3 Use agents SDK schedule / DO alarms for polling video completion (#251)
- 5b39e59 ITE-3075: Convert vibe-rules from TypeScript to markdown format (#250)
- ca2f317 fix: login with slack edge case where user already has an estate (#258)
- 0759802 scopes changes and sign in with slack fix (#243)
- 2bd0099 I forgot to commit this and tests don't cover it - typeid has a maximum prefix length (#257)
- 31e1012 Fix agent init params hydration after durable object alarms (#237)
- b00662b Include files in slack thread history (#253)
- 3261960 Remove all waitUntil inside durable objects (#246)

## 2025-10-07

- f77ef5e Remove annoying linear rules (#249)
- d51ffe0 fix global connection cache (#242)
- 1c56cfb multipart upload (#248)
- 62624a1 Agent detail export (#181)
- 60666f3 signup quickfix (#245)
- 13a9f82 Introduce the Matt Pocock rule (#244)
- 83c1f64 Refine organization onboarding flow (#234)
- 9a0ff97 fix: garple deployment (#241)
- d3e249c chore: add dependabot config (#240)
- 78eba85 chore: update dependencies (#239)
- b228f5a chore: Add projectName to posthog errors (#238)
- 739a630 chore: don't bundle streamdown in server code (#236)
- 6b4cdea Install new shadcn components (#235)

## 2025-10-06

- 9c38316 Add generateVideo tool for SORA 2 video generation (#230)
- 6677961 Add uploadAndShareFileInSlack stub function to SlackAgent (#233)
- bd57003 Automate Slack file sharing for CORE events (#232)
- ef3b3f6 MCP connections UI (#227)
- 8bf1ee7 chore: Split server and client sourcemaps for posthog (#226)
- f88c8cd Filter user notifications by pattern (#210)
- de31436 Add admin role assignment based on email domain (#225)
- b26f961 some stripe tweaks (#217)
- d4b1d7d add system prompt to observability logs (#219)
- 252c11a fix: Correct path for sourcemaps (#224)
- 9e81dbb refactor: Move create org out of hook (#221)
- 2e88680 Reformat garple (#222)
- 89626ad Garple updates (#220)
- 69edfa9 fix: add retries to pkg-pr workflow (#213)
- 78c9686 ci: Improve github actions setup (#215)
- b5fa138 chore: Port garple website (#212)
- aacb183 Revert "Add matcher helper function to parse front matter from YAML files (#209)" (#216)
- dad4543 Add matcher helper function to parse front matter from YAML files (#209)
- e50506c feat: add debug mode to user settings (#211)
- 3e10605 stripebilling (#207)

## 2025-10-03

- cc807de hack to make evals not fail (#208)
- f7917dd multi-trial evals (#201)
- 3268d7f trpc admin ui (#204)
- d6f59dd cli `trpc` subcommand (#202)
- f8b0fb0 missing "t" (#205)
- 80da7fa import logger as logger (#200)
- 58f39b3 fix participant mention event on addition of bot to the new channel (#195)
- e411f82 Return stdout and stderr to the agent (so it can use them for debugging) (#199)
- d56e902 fix: Import sandbox code dynamically (#198)
- b262123 Log when exec in sandbox fails (#197)
- 2bb7abf chore: Upgrade build container size (#196)
- c989892 Coding sandbox (WIP) (#170)
- 02c6b9d delete iterate configs when no config is specified in pnpm dev (#191)
- 19ef344 Ignore unknown users (#167)
- dddb454 Revert "less ugly ternary (#192)" (#194)
- 4a62e50 less ugly ternary (#192)
- c777a9c Getting evals in braintrust (#151)
- f490e9b fix: Filter irrelevant TRPC errors (#190)
- e55d509 Convert dev-wrapper.sh and pg-estate-bootstrap.ts to CLI commands (ITE-3037) (#179)
- db6479f chore: Use prod config for prod db studio (#189)

## 2025-10-02

- 5dd6ff7 Update drizzle schema with foreign keys and cascades (#185)
- 8d24c95 admin page to manage estates and rebuild all (#188)
- dc077a1 A bunch of signup improvements and some admin tools (#184)
- 1b55973 feat: Send errors to posthog (#183)
- ffeb4b9 Remove Claude code review CI action (#187)
- a5a3d2f authClient: throw on error (#180)
- 2b225e8 allow impersonating by estate id (#171)
- 1a99da1 chore: Add cursor background agent setup (#175)
- 736ec4e Redirect to / after impersonating user (ITE-3033) (#178)
- bafd6e4 Add admin impersonation option on estate access error (#161)
- 584aa79 codex script (#177)
- 95db70f add claude CI actions (#172)
- 91b95bc fix format (#176)
- 55da427 vibe rules forever (#174)

## 2025-10-01

- a533f04 tool evals (#153)
- d86b7cb Removes oauth flag (#168)
- a3cd2b0 remove chibi emoji ref (#157)
- 933cb32 chore: Bump build timeout (#165)
- c68f857 fix: Update the callback url (#164)
- 3f12088 fix: Improve error handling in build (#163)
- 73cf88f Fix thread_ts extraction, and make botUserId query suspenseful (#162)
- a1e99d2 fix: Fix websocket status (#159)
- 59fbe62 Feature: automatic redirect (#158)
- 77cd989 disable autofix while it's down (#160)
- 4676014 Avoid unfurling os.iterate.com authorization links (#155)
- 12f6c86 chore: Add nicer error messages for forbidden estates (#156)
- b8ebb06 no lint warnings (#154)
- 1f45778 rm serialised callable stuff (#152)d
- 3832efc add testing router to iterate cli (#148)

## 2025-09-30

- 400d329 always update template repo to bump SDK version (#147)
- 2210318 fix: Add defensive checks for orphaned data (#145)
- af8e351 feat: Rebuilds for repos (#146)
- 5fd5cae evals - first cut (#94)
- dd1ce59 source certain lint rules from vibe-rules/llms.ts (#144)
- 653c6c0 Modify estates/template/iterate.config.ts to test repo syncing (#143)
- 06cf1e2 fix syncing (#142)
- 721d5e0 sync templates folder (#141)
- 1f9f11b a logger of our own (#135)
- 5850e19 feat: add integrations redirect page (#126)

## 2025-09-29

- db9290b fix: Add missing migrations (#138)
- 4e8c81f user impersonation (#136)
- 56a4d3f Feature: create SlackAgent for thread that mentions bot before the bot joined the channel (#125)
- 949da0f feat: Add user to estate cli command (#131)
- 3aa1b5a db:studio:production (#133)
- 4192a17 on conflict estate fix (#134)
- 35ff6ce more verbose tool calling (#132)
- 1bc88a4 smaller sdk publish. (#129)
- f6e75e0 codemirror vscode theme (#130)
- f6e9209 log signature failure (#127)
- 9938795 fix: Delegate to iterate sdk cli (#128)

## 2025-09-26

- 5ec56de Fix: Call syncSlackUsersInBackground when linking Slack on the integrations page (#124)
- e18bf9c chore: revert account unique constrains and update drizzle-kit (#123)
- f353c34 Bring back intelligent link unfurling (#119)
- 00d7711 fix: don't add users to org when linking slack bot (#122)
- ea3b78b hotfix: Ignore null entries (#121)
- 46cb0c8 client fix (#117)
- 7882046 feat: add onError handler/formatter to tRPC endpoint (#120)
- b96912d bring back convo initiation (#112)
- b83b62c Feature: debounced typing indicator (#114)
- 6251e3e Revert "remove extra scope" (#113)
- 824e22d Update linear prompting to retrieve issues correctly (#115)

## 2025-09-25

- e949b10 post internal errors in slack (#104)
- cad086a render certain user/assistant webhooks as messages (#101)
- 1acb523 Make DO tool factory typesafe (#77)
- 614f7a0 Zak clean mcp connect parse (#107)
- d0173c8 remove extra scope (#111)
- 80b389f feat: add deep linkable slack login (#110)
- 5c46cb5 chore: Tell claude useEffect is bad (#108)
- ce34239 speed up first response time by 250ms (#100)
- ac1f966 Verify slack webhooks (#98)
- 807bca2 prefix mcp connections (#106)
- 41ab52f fix little bugs: URL formatting, checking for MCP connection etc. (#105)
- 84c7405 chore: Add even more logging (#103)
- b2bf2fb chore: Add extra logging to failed github auth (#102)
- a94d4ea fix: estate access check checks for all estates (#99)
- 05c716d Feature: support for header/query param auth for MCP connections (#86)
- 555c1c8 feat: Add option for users to start with a template repo (#96)
- 61e8d3b better replicate (#97)
- e8b93e8 port braintrust and posthog tracing (#70)
- d0829b9 fix: Correctly truncate long messages (#95)
- 8a7a10a Update Slack manifest scopes and copy (#93)
- 10b7bf2 replicate (#75)

## 2025-09-24

- 5956088 render slack webhooks in agent detail (#76)
- 642d6f4 debug ui: use jsonata instead of loads of tabs (#85)
- 9fdfa56 fix: use the correct org id for the slack team (#92)
- 03c6e8e feat: Automatically join the estate for the slack team (#91)
- 9f8de7c fix: Slightly more robust iterate config parsing (#90)
- 6b7af77 fix: Truncate long commit messages (#88)
- ab819dd more getting started instructions (#83)
- 763439c feat: Add untils to interact with github app tokens (#84)
- 100b4c0 fix: Build callback (#87)
- d8a96fd remove concept of "user's request" and "completely resolving the request" anchor to helping users achieve their goal (#66)
- e48d3a0 chore: Add deployment grace period (#82)
- 07ade9b Website UX fixes (#81)
- 1b2a763 chore: Update doppler cfg (#80)
- 659090f chore: Set container max instances to 10 (#79)
- 56a4e4b update website to latest version (#73)
- 00ff446 chore: Update dependencies and timeouts (#78)

## 2025-09-23

- 75c3204 Feature: participant management and slack provider user sync (#74)
- bdd4d4e re-instate web search, get url contents and image sharing (#68)
- bf310ee fix: Paginate all github repositories (#72)
- 038d201 fix: Add empty state when missing repo (#71)
- 96a65db fix: Listen to correct event (#69)
- 4c0529e mcp: oauth backed by better auth (#62)
- 186cd45 chore: Port over iterate website (#65)
- 5cdef78 fix tests (#67)
- 1a8971e cli with `iterate estate checkout` (#64)

## 2025-09-22

- 371af0e dedupe context rules better (#60)
- 247ce33 bring back our rules files (#63)
- fdd426b Nickblow/webhook hookup (#52)
- fe8aaca ci: Add QEMU to runner (#61)
- 11b8d8b re-add deadlock with a timeout + error log (#59)
- e0493cf work around db deadlock (#58)
- 0269611 [autofix.ci] apply automated fixes
- 019a448 vibe rules script for codex

## 2025-09-20

- c542475 fix: fix react and websocket client+server problems (#57)
- 8302fe7 chore: move trpc to new style tanstack react query (#56)
- 73aec95 chore: cleanup shadcn components (#55)
- 173ed52 fix regression where prompt fragments from matched context rules are ignored (#54)
- f945dc8 make home link work
- c489dc7 remove lots of vibecoded classenames
- 8dce05f fix commented out code to make it easier to reproduce issue correctly
- 91e78f5 [autofix.ci] apply automated fixes
- 2b12c60 hotfix for broken agent (#53)
- 6b77aba some visual tweaks
- 7ea5198 small UX tweaks
- dd9153a [autofix.ci] apply automated fixes
- 18436b7 Lots of small ticket
- 584f587 Small tidy ups (#46)
- 7dbdf29 feat: add github app integration (#49)
- 92a1d8c feat: Container iterate.config.ts execution (#47)
- d9dd3f8 eyes emoji (#48)
- 292ffc9 disable `curly` (#51)
- 31288ee add .gitattributes (#50)
- 3297da5 compiler hack to cancel out runtime hack
- e3ca6fc avoid ts-expect-error on SlackAgent.getStubByName (#45)
- b0d2db8 hmm
- 79a6ab9 slack challenge endpoint
- 73be737 feat: Local dev for estate config (#44)
- d413abc sync reducer (#26)
- 399b153 enable mcp (#43)
- 6814c40 use stg-inspired config
- 0bf3a38 deploy dev env vars (#42)
- b5d81bb Add sdk package back (#41)
- 3a1b55a Slack webhook store + message history for agent (#38)
- cd4cda9 rm recordRawRequest (#40)
- 8c1138d ci: Apply migrations as part of deployment
- e5779b6 connect slack instructions (#37)
- ccaf43d shut up agents sdk (#36)
- 4390d90 Simplify IterateAgent static methods for stub management (#35)
- 7a1fb65 ci: Add doppler to tests
- 751307a ci: Test workflow
- 28e85fb feat: Auto invalidate middleware (#33)
- 4830dc3 slack agent only responds when mentioned (#32)
- 081c9e6 slack agent talks back (#30)
- 1227fff feat: add token utils and trpc caller (#27)
- 5886179 rip out interactivity for now altogether (#31)
- beb1e4a remove mcp servers from state/events (#28)
- f456360 feat: UI Invalidator (#29)
- 82c7c34 Port agent details, step 1 (#25)
- 1b38b1c ci: Add correct secret to deploy
- e1cbd81 feat: Estate prefix (#21)
- 8dfc8db fix: upload secrets in proper working directory
- d634135 MCP uncommented (#23)
- 507558a fix: add doppler token to doppler setup
- 04e7bd4 ci: fix doppler install
- 216a3eb feat: allow for one click slack login (#22)
- 17bfac0 fix typecheck
- 4a06261 get slack agent working (#19)
- 9706e28 typecheck fix
- 84f1fd7 port SQLITE_TOOBIG fix (#20)
- 2e7cbe9 getting started guide (#18)
- bb3fcde fix: Slightly nicer editing experience for estate
- 10d4bb6 ci: Fix deployment
- d1dcd7f fix: remove path from typecheck
- aec8585 [autofix.ci] apply automated fixes
- 4127d38 chore: Rename package -> os
- 534c482 fix: CI workflow (#17)
- 94b5868 durable object tools work again (#16)
- b43b277 chore: Move to suspense queries
- 712ffa2 chore: Setup ngrok locally
- f838ea7 ci: Fix PNPM version (#14)
- dd2a19f ci: Correct pnpm setup version
- 1a7d87c feat: Estate switcher
- 688daad feat: Edit estate name
- 51cd2de chore: Dedupe dependencies
- 93767ca ci: Add autofix script (#13)
- 286fd90 feat: CI scripts (#12)
- 454aeb7 durable object tools work again (#11)
- 108489a agents ui
- affcb6b feat: Hookup slack (#9)
- b897d52 add iterate agent MVP (#8)
- 8d1720f add iterate agent
- 3d8ff7d fix: Small google login fixes
- c6e4c67 chore: Add minimum release age (#7)
- 09a64ca chore: Add ESLint (#6)
- d15e769 feat: Hookup google login (#5)
- ff74ee7 feat: monorepo structure (#4)
- 8705d44 feat: add better auth (#3)
- 078e5ff feat: add better auth
- e530d68 feat: File uploads (#2)
- f624a22 Merge pull request #1 from iterate-com/ui
- c1b301c Initialize web application via create-cloudflare CLI
