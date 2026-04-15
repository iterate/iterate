We want to create e2e tests of event stream processors.

Requirements:

1. Each test case must be able to "mock the whole internet" / replay from HAR (via mock-http-proxy)
2. Must be possible to run against real deployed processor and events service (as well as possibly locally)
3. Must support testing with _multiple_ processors
4. Need to be able to run a great many tests in parallel

# Implications of requirements

**Each test case needs to deploy or start its own server**
Because "Each test case needs its own mocked internet". The mocked internet needs to point to our mock http proxy and we can only control egress routing for an entire worker (whether run locally or deployed).

**When testing against events.iterate.com, we need to use cloudflare tunnels (or mesh) so events.iterate.com can even reach us**
There should be a usable fixture for this already that uses our semaphore to get a tunnel URL

# What is "under test"

- If we change apps/events, then we can re-run all existing processor tests and make sure they still pas
- If we change a processor, we can use any deployed events app to test the processor change

# Evals vs tests

If we include a non-deterministic or flaky third party in our tests (especially an LLM), then we call the test an eval

# How I want to run a test

## Local test against events.iterate.com

- Input to test:
  - BASE_URL for events.iterate.com
  - Path prefix and namespace for the test

- Group tests into .test.ts files with describe blocks and tests

### Setting up a test

These steps should all be hidden in a fixture

- Create a mock http proxy -> gives me set of egress env vars (or a base URL I can use as external egress proxy)
- Obtain base URL for mock http proxy
  - Needs to be routable from where the "processor under test" is running - so if processor under test is deployed,
    we need a cloudflare tunnel
- Spin up the server that wraps my processor
  - Provide it with the mock http proxy base URL to be used as external egress proxy (or use env https_proxy env var etc)

- Obtain base URL for the processor server
  - This needs to be routable from whatever events.iterate.com deployment/process we're using
  - So generally speaking will need a cloudflare tunnel

- Generate a _path_ just for this test

- This gives us
  - A mock http proxy fixture
  - An orpc client for apps/events
  - A _path_

# Future improvements

- Use mesh network instead of cloudflare tunnel
- Use a single mock http proxy for all tests in a given test file (multiplex across tests using paths)
