/**
 * Maximum in-file test concurrency for the deployed OS e2e suite.
 *
 * Family-owned project pools use the same value so acquiring an exclusive
 * mutable project never serializes a test Vitest has made runnable.
 */
export const E2E_FILE_TEST_CONCURRENCY = 2;
