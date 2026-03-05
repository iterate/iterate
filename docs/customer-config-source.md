How do we persist the customer config source?

Options broadly categorised into "git-server" and "archil"

A. github.com/iterate-projects/<project-slug>

- pro: `git` cli works
- pro: `gh` cli works
- pro: very close to how we use it
- pro: we are free to put both `git` and `github` related stuff in global system prompts etc.
- con: complicated management, transfer of repo to customer
- con: maybe we don't want git at all

B. git.iterate.com/<project-slug> (DO + R2 based basic git server)

- pro: we own it fully. no complicated logic about which installation id controls the customer repo
- pro: `git` cli works
- con: `gh` cli doesn't work
- con: maybe we don't want git at all

C. local git repo + archil direct sync

- pro: we own full, no complicated management
- pro: `git` cli works
- con: `gh` cli doesn't work
- con: archil sync might go v slowly if there are many small files in node_modules
- con: maybe we don't want git at all

D. local folder, not git + archil direct sync

- pro: we own full, no complicated management
- con: `git` cli doesn't work
- con: no version control unless we build ourselves
- con: `gh` cli doesn't work
- con: archil sync might go v slowly if there are many small files in node_modules
- pro: "just a folder" - no assumptions to build hard-to-walk-back dependencies on top of

E. [the above archil options but with periodic tarballification and syncing with ~/.local/share/something]

- con: merge conflicts could be messy
- pro: archil sync will be fast and work well

F. gitea.iterate.com

- pro: we own the infra/auth
- pro: `git` cli works
- pro: `gh` cli mostly works
- con: probably somewhat more complex to deploy + manage that DO+R2
- con: maybe we don't want git at all

Questions:

Q: Who is this for?
A: Anna/Sasha. New customers, possibly not very technical. Don't want to setup a github account for this.

Q: Will non-technical people really have large node_modules folders/need for gitignore, version-control etc.?
A: I think so, yes. One use case Anna had was "make me a deck about why Marty Supreme performed better than Smashing Machine". It installed a bunch of modules for that, although does that belong in the "customer config source" folder? Very possibly not, but if not where exactly? Similarly my brother also wanted a medium-term website specifically for his company's AGM. He would want that version-controlled (even though he knows nothing of the technical details or the difference between source code and build artifacts). The agent will be very good at navigating git, and probably quite bad at navigating whatever pseudo-vcs we come up with.

Q: Does archil actually struggle with large node_modules folders?
A: Maybe. I saw something like this but I don't feel that confident in it. Need to run more tests/ask Hunter before making decisions based on this assumption.

Q: Is it freeing/good or constricting/bad to assume of the customer config source is a git repo?
A:

---

My answer: freeing/good. Jonas's answer: constricting/bad.

My argument: we can write AGENTS.md in our default/recommended system prompts the way we are naturally inclined to ("commit frequently, create branches/worktrees if experimenting") without worrying about if the customer has a git repo or not - they always do (doesn't extend as far as github, but I think git is a good middle ground). Local git repos are definitely "in the weights". "Customer repo" is an easily-understandable term that we can throw around accurately. We get tons of features for free that I suspect we'll want, even for non-technical customers. (high-quality version control, gitignore, commit hooks)

Jonas argument: we should build these things as onion layers, and it's simplifying to say "it's just a folder, feel free to put stuff in there" and add git-specific instructions as an optional layer. That's how openclaw works. "It's just a folder, go nuts"

## Related question: is it more important that we make this whole things as onion-y as possible, or that we make the new customer experience as close to our experience as possible?

Q: where is this folder?
A: Options if on a hosted git server: `~/github.com/iterate-projects/my-project` or `~/git.iterate.com/my-org/my-project` or `~/gitea.iterate.com/my-org/my-project` depending on which remote server we choose. If not a hosted git server, could/should probably be something like `~/workspace`? Or, should it _always_ be workspace and be symlinked to `~/github.com/iterate-projects/my-project`

Q: what does it contain by default/for new customers?
A: Our default/recommended config. An AGENTS.md, an iterate.config.ts with handy mcp servers, a few skills? Maybe not a server for the default? Or maybe yes?

Q: will we really be tying ourselves in knots that much with a "managed github" repo?
A: Probably. It felt like a mess last time. But maybe we've learned and grown?
