/**
 * The shop's expire-tokens control (test-controls.ts): it names one account of one client, and
 * moves on that account's revocation epoch alone. What an expiry does to the tokens themselves is
 * authorization-server.test.ts.
 */
import { expect, test } from "vitest";
import { memoryPetshop } from "./memory-state.ts";
import { handleTestControls } from "./test-controls.ts";

test.for([
  {
    name: "without an account it answers 400 and expires nothing",
    body: { clientId: "petshop-default" },
    answer: { status: 400, body: { error: "invalid_request" } },
    epochs: [],
  },
  {
    name: "with an account it moves on that account's epoch at the client, and no other",
    body: { clientId: "petshop-default", account: "ada@example.com" },
    answer: {
      status: 200,
      body: { clientId: "petshop-default", account: "ada@example.com", accessTokenEpoch: 1 },
    },
    epochs: [["petshop-default:ada@example.com", 1]],
  },
  {
    name: "the Tesco client the OS e2e helpers name, tesco-login:<email>, is the client tesco-login",
    body: { clientId: "tesco-login:ada@example.com", account: "ada@example.com" },
    answer: {
      status: 200,
      body: { clientId: "tesco-login", account: "ada@example.com", accessTokenEpoch: 1 },
    },
    epochs: [["tesco-login:ada@example.com", 1]],
  },
])("expire-tokens $name", async ({ body, answer, epochs }) => {
  const petshop = memoryPetshop();

  const response = await handleTestControls(
    new Request("https://petshop.test/__test-controls/expire-tokens", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    petshop,
  );

  expect({ status: response.status, body: await response.json() }).toMatchObject(answer);
  // exactly these epochs: an expiry touches no other account's
  expect(Object.entries((await petshop.state.getState()).accessTokenEpochs)).toEqual(epochs);
});
