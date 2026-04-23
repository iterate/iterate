import {
  H as intercept,
  f as toStandardLazyResponse,
  i as StandardRPCLink,
  l as toFetchRequest,
  rt as toArray,
  t as CompositeStandardLinkPlugin,
} from "./client.DrB9nq_G-C5sxXqjr.js";
//#region node_modules/@orpc/client/dist/adapters/fetch/index.mjs
var CompositeLinkFetchPlugin = class extends CompositeStandardLinkPlugin {
  initRuntimeAdapter(options) {
    for (const plugin of this.plugins) plugin.initRuntimeAdapter?.(options);
  }
};
var LinkFetchClient = class {
  fetch;
  toFetchRequestOptions;
  adapterInterceptors;
  constructor(options) {
    new CompositeLinkFetchPlugin(options.plugins).initRuntimeAdapter(options);
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.toFetchRequestOptions = options;
    this.adapterInterceptors = toArray(options.adapterInterceptors);
  }
  async call(standardRequest, options, path, input) {
    const request = toFetchRequest(standardRequest, this.toFetchRequestOptions);
    return toStandardLazyResponse(
      await intercept(
        this.adapterInterceptors,
        {
          ...options,
          request,
          path,
          input,
          init: { redirect: "manual" },
        },
        ({ request: request2, path: path2, input: input2, init, ...options2 }) =>
          this.fetch(request2, init, options2, path2, input2),
      ),
      { signal: request.signal },
    );
  }
};
var RPCLink = class extends StandardRPCLink {
  constructor(options) {
    const linkClient = new LinkFetchClient(options);
    super(linkClient, options);
  }
};
//#endregion
export { RPCLink as n, LinkFetchClient as t };
