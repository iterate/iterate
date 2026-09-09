# Codex reviewers — relaunch kit

Twelve OpenAI Codex reviewers (`gpt-5.6-sol`, reasoning effort `xhigh`, read-only sandbox) were
launched on 2026-09-02 over the same twelve questions the Claude reviewers answered
(`docs/reviews/2026-09-02-*.md`). All twelve died at the OpenAI workspace's credit wall
("Your workspace is out of credits") while still reading, so no report was produced.

To relaunch once credits exist, from `packages/v3/project-worker`:

```sh
for k in prompts/*.prompt.txt; do
  t=$(basename "$k" .prompt.txt)
  codex exec -C "$PWD" -s read-only -m gpt-5.6-sol -c model_reasoning_effort="xhigh" --color never \
    -o "docs/reviews/codex/$(date +%F)-$t.md" - < "docs/reviews/codex/$k" > "/tmp/codex-$t.log" 2>&1 &
done; wait
```

Each prompt tells the reviewer that its final message is captured verbatim as the report, so the
`-o` file is the deliverable. The prompts embed the owner's doctrine and point at the existing
Claude reports so a Codex pass builds on them and says where it disagrees.
