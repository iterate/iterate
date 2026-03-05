---
state: draft
priority: high
size: medium
tags: [security]
---

# CI Secrets Scoping & Spending Limits

## Problem

Prompt injection vector: CI runs on every PR, agents can open PRs, and the CI runner has a Doppler token granting access to `dev` secrets -- which are often the same as `prd` secrets. A malicious PR could exfiltrate secrets via CI.

## Solution

### 1. Create a dedicated `ci` Doppler config

Create a `ci` config in Doppler with only the secrets CI actually needs. This limits blast radius if CI is compromised.

- Audit which secrets CI uses (DB URLs, API keys, etc.)
- Create `ci` config with minimal subset
- Update CI workflows to use `doppler run --config ci`
- Ensure `ci` config does NOT contain production-equivalent secrets

### 2. Spending limits on API keys

For any API keys CI has access to (LLM providers, cloud services, etc.), set spending limits / rate limits:

- Add spending caps on OpenAI/Anthropic API keys used in CI
- Use separate API keys for CI vs production where possible
- Set up billing alerts for unexpected spend spikes

### 3. Reduce secret overlap between dev and prd

Audit `dev` and `prd` Doppler configs for shared secrets. Where possible:

- Use separate credentials per environment
- Ensure `dev` keys can't access production resources
- Rotate any secrets that were previously shared

### 4. Consider whether traditional CI is still needed

Given that coding agents run `pnpm test` locally before pushing, evaluate whether CI test runs are redundant. If CI is only needed for deployment triggers and artifact building, the secret surface area shrinks significantly.

## Tasks

- [ ] Audit which Doppler secrets CI currently uses
- [ ] Create `ci` Doppler config with minimal secrets
- [ ] Update CI workflows to use `--config ci`
- [ ] Set spending limits on all API keys visible to CI
- [ ] Create separate API keys for CI where possible
- [ ] Audit and reduce dev/prd secret overlap
- [ ] Evaluate reducing CI scope (skip tests, agent handles locally)

## Context

- Raised by @mmkal in Slack thread on 2026-02-20
- Related to prompt injection risk via agent-opened PRs triggering CI
