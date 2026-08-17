https://os.iterate.com/projects/misha/agents/streams/agents/mobile/2026-08-03t16-27-32-701z

This chat did not go very well.

Problems:

- It took eight rounds to complete the request.
- It used `itx.ai.run(...)` instead of returning results and letting the agent's own model process them.
- It parsed HTML manually with regular expressions instead of using a suitable conversion capability such as `toMarkdown(...)`.
- Truncation left the agent guessing how to use prior results.

Success criteria: the new run should clearly improve on the historical stream without any of the problems above.
