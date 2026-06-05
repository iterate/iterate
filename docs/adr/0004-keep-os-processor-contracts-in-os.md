# Keep OS Processor Contracts In OS

During the `packages/streams` cutover, OS-specific processor contracts and implementations will stay in `apps/os` instead of moving into `@iterate-com/streams`. The stream package should provide app-agnostic runtime infrastructure, while Project lifecycle, Repo lifecycle, Codemode, Agent, Slack, Secret, and Workspace semantics remain OS domain language. This can be revisited later for processors that prove reusable, but moving them now would make the generic stream runtime depend on OS product concepts.
