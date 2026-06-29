import { RpcTarget } from "cloudflare:workers";
import {
  FakeAuthContext,
  ITX_AUTH_COOKIE,
  parseItxAuthToken,
  readCookie,
  TRUSTED_INTERNAL_ITX_TOKEN,
} from "../../auth.ts";
import { ProjectCollectionRpcTarget } from "../projects/rpc-targets.ts";
import type { CfExecutionContext, RpcTargetImplementation } from "../../rpc-target-types.ts";
import type { ItxAuth, ItxAuthCredentials, ItxRoot, UnauthenticatedItx } from "./types.ts";

class ItxRootRpcTarget extends RpcTarget implements RpcTargetImplementation<ItxRoot> {
  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext }) {
    super();
  }

  get projects() {
    return new ProjectCollectionRpcTarget({ auth: this.props.auth, ctx: this.props.ctx });
  }

  whoami() {
    return this.props.auth.principal;
  }
}

export class UnauthenticatedItxRpcTarget
  extends RpcTarget
  implements RpcTargetImplementation<UnauthenticatedItx>
{
  constructor(
    readonly requestHeaders: Headers,
    readonly ctx: CfExecutionContext,
  ) {
    super();
  }

  authenticate(input: ItxAuthCredentials) {
    let auth: ItxAuth | null = null;

    if (input.type === "token") {
      auth = new FakeAuthContext(input.token);
    }

    if (input.type === "from-server-cookie") {
      const cookieToken = readCookie(this.requestHeaders.get("cookie"), ITX_AUTH_COOKIE);
      if (cookieToken) auth = new FakeAuthContext(parseItxAuthToken(cookieToken));
    }

    if (input.type === "trusted-internal" && input.token === TRUSTED_INTERNAL_ITX_TOKEN) {
      auth = new FakeAuthContext({ principal: "trusted-internal", type: "admin" });
    }

    if (!auth) throw new Error("missing or invalid auth");

    return new ItxRootRpcTarget({ auth, ctx: this.ctx });
  }
}
