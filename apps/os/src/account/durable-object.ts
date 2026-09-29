// src/account/durable-object.ts — THE ACCOUNT HOST: the facet a user's account context hosts under
// the name `account`. Hosted from `ctx.exports` (first-party-facets.ts) — ordinary bundled worker
// code, never a loaded source — and enabled with `processors.enable("account")`, no spec: the
// reserved name IS the class. It pulls `AccountProcessor` from ./processor.ts (the tested spec), so
// the `reduce` that runs in the facet IS the `reduce` the unit test drives — no hand-kept twin to
// drift. And THE PERSON'S OWN CONNECTIONS (src/integrations/verbs.ts): connected, finished and
// disconnected here exactly as a project's are on its `project` facet, over this context's
// `/users/<id>` root. Reached as `session.user.integrations.connect(…)` and `.disconnect(…)`
// (context/built-ins.ts); the callback finishes (secret-oauth-callback.ts).
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import type { AppConfigEnv } from "../app-config.ts";
import { DurableObjectNameCodec } from "../context/paths.ts";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import type { IterateContextDurableObject } from "../iterate-context-durable-object.ts";
import type { IntegrationProvider } from "../integrations/contract.ts";
import type { IntegrationScope } from "../integrations/connections.ts";
import {
  connectIntegration,
  disconnectIntegration,
  finishIntegrationConnect,
  type ConnectInput,
  type FinishConnectAnswer,
  type FinishConnectInput,
} from "../integrations/verbs.ts";
import type { ConnectionAttempt } from "../integrations/connections.ts";
import type { AccountState } from "./contract.ts";
import { AccountProcessor } from "./processor.ts";

export class AccountDurableObject extends StreamProcessorDurableObject<
  AccountState,
  {
    ITX?: ItxEntrypointService;
    DB: D1Database;
    ITERATE_CONTEXT: DurableObjectNamespace<IterateContextDurableObject>;
  } & AppConfigEnv,
  ItxEntrypointScope
> {
  processor = new AccountProcessor();

  #integrationScope(): IntegrationScope {
    const { projectId, path } = DurableObjectNameCodec.parse(this.ctx.props.iterateContextName);
    return {
      env: this.env,
      projectId,
      rootPath: path,
      getItx: () => this.getItx(),
      storage: this.ctx.storage,
    };
  }

  async #integrations() {
    return (await this.snapshot()).state.integrations;
  }

  /** A person's connect: Google or Cloudflare through iterate's client (`integrations.connect`),
   *  or one a project asked for (`integrations.connectForProject`, the platform's alone): once its
   *  consent finishes, the account is connected there. */
  async connectIntegration(
    input: ConnectInput,
    connectToProject?: ConnectionAttempt["connectToProject"],
  ): Promise<{ authorizationUrl: string }> {
    return connectIntegration(
      this.#integrationScope(),
      await this.#integrations(),
      input,
      connectToProject,
    );
  }

  /** The OAuth callback's (context/built-ins.ts `integrations.finishConnect`). */
  async finishIntegrationConnect(input: FinishConnectInput): Promise<FinishConnectAnswer> {
    return finishIntegrationConnect(this.#integrationScope(), await this.#integrations(), input);
  }

  async disconnectIntegration(input: {
    provider: IntegrationProvider;
    connection: string;
  }): Promise<void> {
    await disconnectIntegration(this.#integrationScope(), await this.#integrations(), input);
  }
}
