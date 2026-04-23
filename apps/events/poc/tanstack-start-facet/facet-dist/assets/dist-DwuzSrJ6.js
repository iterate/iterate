import {
  $ as runWithSpan,
  A as withEventMeta,
  C as HibernationEventIterator,
  D as getFilenameFromContentDisposition,
  E as getEventMeta,
  G as isTypescriptObject,
  I as SequentialIdGenerator,
  M as AsyncIdQueue,
  N as AsyncIteratorClass,
  O as isEventIteratorHeaders,
  Q as runInSpanContext,
  R as clone,
  S as ErrorEvent,
  T as generateContentDisposition,
  U as isAsyncIteratorObject,
  V as getGlobalOtelConfig,
  X as readAsBuffer,
  et as setSpanError,
  j as AbortError,
  nt as stringifyJSON,
  tt as startSpan,
  w as flattenHeader,
} from "./client.DrB9nq_G-C5sxXqjr.js";
//#region node_modules/@orpc/standard-server-peer/dist/index.mjs
var SHORTABLE_ORIGIN = "http://orpc";
var SHORTABLE_ORIGIN_MATCHER = /^http:\/\/orpc\//;
var MessageType = /* @__PURE__ */ ((MessageType2) => {
  MessageType2[(MessageType2["REQUEST"] = 1)] = "REQUEST";
  MessageType2[(MessageType2["RESPONSE"] = 2)] = "RESPONSE";
  MessageType2[(MessageType2["EVENT_ITERATOR"] = 3)] = "EVENT_ITERATOR";
  MessageType2[(MessageType2["ABORT_SIGNAL"] = 4)] = "ABORT_SIGNAL";
  return MessageType2;
})(MessageType || {});
function serializeRequestMessage(id, type, payload) {
  if (type === 3) {
    const eventPayload = payload;
    return {
      i: id,
      t: type,
      p: {
        e: eventPayload.event,
        d: eventPayload.data,
        m: eventPayload.meta,
      },
    };
  }
  if (type === 4)
    return {
      i: id,
      t: type,
      p: payload,
    };
  const request = payload;
  return {
    i: id,
    p: {
      u: request.url.toString().replace(SHORTABLE_ORIGIN_MATCHER, "/"),
      b: request.body,
      h: Object.keys(request.headers).length > 0 ? request.headers : void 0,
      m: request.method === "POST" ? void 0 : request.method,
    },
  };
}
function deserializeRequestMessage(message) {
  const id = message.i;
  const type = message.t ?? 1;
  if (type === 3) {
    const payload2 = message.p;
    return [
      id,
      type,
      {
        event: payload2.e,
        data: payload2.d,
        meta: payload2.m,
      },
    ];
  }
  if (type === 4) return [id, type, message.p];
  const payload = message.p;
  return [
    id,
    1,
    {
      url: payload.u.startsWith("/")
        ? new URL(`${SHORTABLE_ORIGIN}${payload.u}`)
        : new URL(payload.u),
      headers: payload.h ?? {},
      method: payload.m ?? "POST",
      body: payload.b,
    },
  ];
}
function serializeResponseMessage(id, type, payload) {
  if (type === 3) {
    const eventPayload = payload;
    return {
      i: id,
      t: type,
      p: {
        e: eventPayload.event,
        d: eventPayload.data,
        m: eventPayload.meta,
      },
    };
  }
  if (type === 4)
    return {
      i: id,
      t: type,
      p: void 0,
    };
  const response = payload;
  return {
    i: id,
    p: {
      s: response.status === 200 ? void 0 : response.status,
      h: Object.keys(response.headers).length > 0 ? response.headers : void 0,
      b: response.body,
    },
  };
}
function deserializeResponseMessage(message) {
  const id = message.i;
  const type = message.t;
  if (type === 3) {
    const payload2 = message.p;
    return [
      id,
      type,
      {
        event: payload2.e,
        data: payload2.d,
        meta: payload2.m,
      },
    ];
  }
  if (type === 4) return [id, type, message.p];
  const payload = message.p;
  return [
    id,
    2,
    {
      status: payload.s ?? 200,
      headers: payload.h ?? {},
      body: payload.b,
    },
  ];
}
async function encodeRequestMessage(id, type, payload) {
  if (type === 3 || type === 4) return encodeRawMessage(serializeRequestMessage(id, type, payload));
  const request = payload;
  const { body: processedBody, headers: processedHeaders } = await serializeBodyAndHeaders(
    request.body,
    request.headers,
  );
  const baseMessage = serializeRequestMessage(id, 1, {
    ...request,
    body: processedBody instanceof Blob ? void 0 : processedBody,
    headers: processedHeaders,
  });
  if (processedBody instanceof Blob) return encodeRawMessage(baseMessage, processedBody);
  return encodeRawMessage(baseMessage);
}
async function decodeRequestMessage(raw) {
  const { json: message, buffer } = await decodeRawMessage(raw);
  const [id, type, payload] = deserializeRequestMessage(message);
  if (type === 3 || type === 4) return [id, type, payload];
  const request = payload;
  const body = await deserializeBody(request.headers, request.body, buffer);
  return [
    id,
    type,
    {
      ...request,
      body,
    },
  ];
}
async function encodeResponseMessage(id, type, payload) {
  if (type === 3 || type === 4)
    return encodeRawMessage(serializeResponseMessage(id, type, payload));
  const response = payload;
  const { body: processedBody, headers: processedHeaders } = await serializeBodyAndHeaders(
    response.body,
    response.headers,
  );
  const baseMessage = serializeResponseMessage(id, 2, {
    ...response,
    body: processedBody instanceof Blob ? void 0 : processedBody,
    headers: processedHeaders,
  });
  if (processedBody instanceof Blob) return encodeRawMessage(baseMessage, processedBody);
  return encodeRawMessage(baseMessage);
}
async function decodeResponseMessage(raw) {
  const { json: message, buffer } = await decodeRawMessage(raw);
  const [id, type, payload] = deserializeResponseMessage(message);
  if (type === 3 || type === 4) return [id, type, payload];
  const response = payload;
  const body = await deserializeBody(response.headers, response.body, buffer);
  return [
    id,
    type,
    {
      ...response,
      body,
    },
  ];
}
async function serializeBodyAndHeaders(body, originalHeaders) {
  const headers = { ...originalHeaders };
  const originalContentDisposition = headers["content-disposition"];
  delete headers["content-type"];
  delete headers["content-disposition"];
  if (body instanceof Blob) {
    headers["content-type"] = body.type;
    headers["content-disposition"] =
      originalContentDisposition ??
      generateContentDisposition(body instanceof File ? body.name : "blob");
    return {
      body,
      headers,
    };
  }
  if (body instanceof FormData) {
    const tempRes = new Response(body);
    headers["content-type"] = tempRes.headers.get("content-type");
    return {
      body: await tempRes.blob(),
      headers,
    };
  }
  if (body instanceof URLSearchParams) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    return {
      body: body.toString(),
      headers,
    };
  }
  if (isAsyncIteratorObject(body)) {
    headers["content-type"] = "text/event-stream";
    return {
      body: void 0,
      headers,
    };
  }
  return {
    body,
    headers,
  };
}
async function deserializeBody(headers, body, buffer) {
  const contentType = flattenHeader(headers["content-type"]);
  const contentDisposition = flattenHeader(headers["content-disposition"]);
  if (typeof contentDisposition === "string") {
    const filename = getFilenameFromContentDisposition(contentDisposition) ?? "blob";
    return new File(buffer === void 0 ? [] : [buffer], filename, { type: contentType });
  }
  if (contentType?.startsWith("multipart/form-data"))
    return new Response(buffer, { headers: { "content-type": contentType } }).formData();
  if (contentType?.startsWith("application/x-www-form-urlencoded") && typeof body === "string")
    return new URLSearchParams(body);
  return body;
}
var JSON_AND_BINARY_DELIMITER = 255;
async function encodeRawMessage(data, blob) {
  const json = stringifyJSON(data);
  if (blob === void 0 || blob.size === 0) return json;
  return readAsBuffer(
    new Blob([new TextEncoder().encode(json), new Uint8Array([JSON_AND_BINARY_DELIMITER]), blob]),
  );
}
async function decodeRawMessage(raw) {
  if (typeof raw === "string") return { json: JSON.parse(raw) };
  const buffer = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const delimiterIndex = buffer.indexOf(JSON_AND_BINARY_DELIMITER);
  if (delimiterIndex === -1) {
    const jsonPart2 = new TextDecoder().decode(buffer);
    return { json: JSON.parse(jsonPart2) };
  }
  const jsonPart = new TextDecoder().decode(buffer.subarray(0, delimiterIndex));
  const bufferPart = buffer.subarray(delimiterIndex + 1);
  return {
    json: JSON.parse(jsonPart),
    buffer: bufferPart,
  };
}
function toEventIterator(queue, id, cleanup, options = {}) {
  let span;
  return new AsyncIteratorClass(
    async () => {
      span ??= startSpan("consume_event_iterator_stream");
      try {
        const item = await runInSpanContext(span, () => queue.pull(id));
        switch (item.event) {
          case "message": {
            let data = item.data;
            if (item.meta && isTypescriptObject(data)) data = withEventMeta(data, item.meta);
            span?.addEvent("message");
            return {
              value: data,
              done: false,
            };
          }
          case "error": {
            let error = new ErrorEvent({ data: item.data });
            if (item.meta) error = withEventMeta(error, item.meta);
            span?.addEvent("error");
            throw error;
          }
          case "done": {
            let data = item.data;
            if (item.meta && isTypescriptObject(data)) data = withEventMeta(data, item.meta);
            span?.addEvent("done");
            return {
              value: data,
              done: true,
            };
          }
        }
      } catch (e) {
        if (!(e instanceof ErrorEvent)) setSpanError(span, e, options);
        throw e;
      }
    },
    async (reason) => {
      try {
        if (reason !== "next") span?.addEvent("cancelled");
        await runInSpanContext(span, () => cleanup(reason));
      } catch (e) {
        setSpanError(span, e, options);
        throw e;
      } finally {
        span?.end();
      }
    },
  );
}
function resolveEventIterator(iterator, callback) {
  return runWithSpan({ name: "stream_event_iterator" }, async (span) => {
    while (true) {
      const payload = await (async () => {
        try {
          const { value, done } = await iterator.next();
          if (done) {
            span?.addEvent("done");
            return {
              event: "done",
              data: value,
              meta: getEventMeta(value),
            };
          }
          span?.addEvent("message");
          return {
            event: "message",
            data: value,
            meta: getEventMeta(value),
          };
        } catch (err) {
          if (err instanceof ErrorEvent) {
            span?.addEvent("error");
            return {
              event: "error",
              data: err.data,
              meta: getEventMeta(err),
            };
          } else {
            try {
              await callback({
                event: "error",
                data: void 0,
              });
            } catch (err2) {
              setSpanError(span, err);
              throw err2;
            }
            throw err;
          }
        }
      })();
      let isInvokeCleanupFn = false;
      try {
        const direction = await callback(payload);
        if (payload.event === "done" || payload.event === "error") return;
        if (direction === "abort") {
          isInvokeCleanupFn = true;
          await iterator.return?.();
          return;
        }
      } catch (err) {
        if (!isInvokeCleanupFn)
          try {
            await iterator.return?.();
          } catch (err2) {
            setSpanError(span, err);
            throw err2;
          }
        throw err;
      }
    }
  });
}
var ClientPeer = class {
  peer;
  constructor(send) {
    this.peer = new experimental_ClientPeerWithoutCodec(async ([id, type, payload]) => {
      await send(await encodeRequestMessage(id, type, payload));
    });
  }
  get length() {
    return this.peer.length;
  }
  open(id) {
    return this.peer.open(id);
  }
  async request(request) {
    return this.peer.request(request);
  }
  async message(raw) {
    return this.peer.message(await decodeResponseMessage(raw));
  }
  close(options = {}) {
    return this.peer.close(options);
  }
};
var experimental_ClientPeerWithoutCodec = class {
  idGenerator = new SequentialIdGenerator();
  /**
   * Queue of responses sent from server, awaiting consumption
   */
  responseQueue = new AsyncIdQueue();
  /**
   * Queue of event iterator messages sent from server, awaiting consumption
   */
  serverEventIteratorQueue = new AsyncIdQueue();
  /**
   * Controllers used to signal that the client should stop sending event iterator messages
   */
  serverControllers = /* @__PURE__ */ new Map();
  /**
   * Cleanup functions invoked when the request/response is closed
   */
  cleanupFns = /* @__PURE__ */ new Map();
  send;
  constructor(send) {
    this.send = async (message) => {
      const id = message[0];
      if (this.serverControllers.has(id)) await send(message);
    };
  }
  get length() {
    return (
      (+this.responseQueue.length +
        this.serverEventIteratorQueue.length +
        this.serverControllers.size +
        this.cleanupFns.size) /
      4
    );
  }
  open(id) {
    this.serverEventIteratorQueue.open(id);
    this.responseQueue.open(id);
    const controller = new AbortController();
    this.serverControllers.set(id, controller);
    this.cleanupFns.set(id, []);
    return controller;
  }
  async request(request) {
    const signal = request.signal;
    return runWithSpan(
      {
        name: "send_peer_request",
        signal,
      },
      async () => {
        if (signal?.aborted) throw signal.reason;
        const id = this.idGenerator.generate();
        const serverController = this.open(id);
        try {
          const otelConfig = getGlobalOtelConfig();
          if (otelConfig) {
            const headers = clone(request.headers);
            otelConfig.propagation.inject(otelConfig.context.active(), headers);
            request = {
              ...request,
              headers,
            };
          }
          await this.send([id, MessageType.REQUEST, request]);
          if (signal?.aborted) {
            await this.send([id, MessageType.ABORT_SIGNAL, void 0]);
            throw signal.reason;
          }
          let abortListener;
          signal?.addEventListener(
            "abort",
            (abortListener = async () => {
              await this.send([id, MessageType.ABORT_SIGNAL, void 0]);
              this.close({
                id,
                reason: signal.reason,
              });
            }),
            { once: true },
          );
          this.cleanupFns.get(id)?.push(() => {
            signal?.removeEventListener("abort", abortListener);
          });
          if (isAsyncIteratorObject(request.body)) {
            const iterator = request.body;
            resolveEventIterator(iterator, async (payload) => {
              if (serverController.signal.aborted) return "abort";
              await this.send([id, MessageType.EVENT_ITERATOR, payload]);
              return "next";
            });
          }
          const response = await this.responseQueue.pull(id);
          if (isEventIteratorHeaders(response.headers)) {
            const iterator = toEventIterator(
              this.serverEventIteratorQueue,
              id,
              async (reason) => {
                try {
                  if (reason !== "next") await this.send([id, MessageType.ABORT_SIGNAL, void 0]);
                } finally {
                  this.close({ id });
                }
              },
              { signal },
            );
            return {
              ...response,
              body: iterator,
            };
          }
          this.close({ id });
          return response;
        } catch (err) {
          this.close({
            id,
            reason: err,
          });
          throw err;
        }
      },
    );
  }
  async message([id, type, payload]) {
    if (type === MessageType.ABORT_SIGNAL) {
      this.serverControllers.get(id)?.abort();
      return;
    }
    if (type === MessageType.EVENT_ITERATOR) {
      if (this.serverEventIteratorQueue.isOpen(id)) this.serverEventIteratorQueue.push(id, payload);
      return;
    }
    if (!this.responseQueue.isOpen(id)) return;
    this.responseQueue.push(id, payload);
  }
  close(options = {}) {
    if (options.id !== void 0) {
      this.serverControllers.get(options.id)?.abort(options.reason);
      this.serverControllers.delete(options.id);
      this.cleanupFns.get(options.id)?.forEach((fn) => fn());
      this.cleanupFns.delete(options.id);
    } else {
      this.serverControllers.forEach((c) => c.abort(options.reason));
      this.serverControllers.clear();
      this.cleanupFns.forEach((fns) => fns.forEach((fn) => fn()));
      this.cleanupFns.clear();
    }
    this.responseQueue.close(options);
    this.serverEventIteratorQueue.close(options);
  }
};
var ServerPeer = class {
  peer;
  constructor(send) {
    this.peer = new experimental_ServerPeerWithoutCodec(async ([id, type, payload]) => {
      await send(await encodeResponseMessage(id, type, payload));
    });
  }
  get length() {
    return this.peer.length;
  }
  open(id) {
    return this.peer.open(id);
  }
  /**
   * @todo This method will return Promise<void> in the next major version.
   */
  async message(raw, handleRequest) {
    return this.peer.message(await decodeRequestMessage(raw), handleRequest);
  }
  /**
   * @deprecated Please pass the `handleRequest` (second arg) function to the `message` method instead.
   */
  async response(id, response) {
    return this.peer.response(id, response);
  }
  close({ abort = true, ...options } = {}) {
    return this.peer.close({
      ...options,
      abort,
    });
  }
};
var experimental_ServerPeerWithoutCodec = class {
  /**
   * Queue of event iterator messages sent from client, awaiting consumption
   */
  clientEventIteratorQueue = new AsyncIdQueue();
  /**
   * Map of active client request controllers, should be synced to request signal
   */
  clientControllers = /* @__PURE__ */ new Map();
  send;
  constructor(send) {
    this.send = async (message) => {
      const id = message[0];
      if (this.clientControllers.has(id)) await send(message);
    };
  }
  get length() {
    return (this.clientEventIteratorQueue.length + this.clientControllers.size) / 2;
  }
  open(id) {
    this.clientEventIteratorQueue.open(id);
    const controller = new AbortController();
    this.clientControllers.set(id, controller);
    return controller;
  }
  /**
   * @todo This method will return Promise<void> in the next major version.
   */
  async message([id, type, payload], handleRequest) {
    if (type === MessageType.ABORT_SIGNAL) {
      this.close({
        id,
        reason: new AbortError("Client aborted the request"),
      });
      return [id, void 0];
    }
    if (type === MessageType.EVENT_ITERATOR) {
      if (this.clientEventIteratorQueue.isOpen(id)) this.clientEventIteratorQueue.push(id, payload);
      return [id, void 0];
    }
    if (this.clientControllers.has(id)) return [id, void 0];
    const signal = this.open(id).signal;
    const request = {
      ...payload,
      signal,
      body: isEventIteratorHeaders(payload.headers)
        ? toEventIterator(
            this.clientEventIteratorQueue,
            id,
            async (reason) => {
              if (reason !== "next") await this.send([id, MessageType.ABORT_SIGNAL, void 0]);
            },
            { signal },
          )
        : payload.body,
    };
    if (handleRequest) {
      let context;
      const otelConfig = getGlobalOtelConfig();
      if (otelConfig)
        context = otelConfig.propagation.extract(otelConfig.context.active(), request.headers);
      await runWithSpan(
        {
          name: "receive_peer_request",
          context,
        },
        async () => {
          const response = await runWithSpan({ name: "handle_request" }, async () => {
            try {
              return await handleRequest(request);
            } catch (reason) {
              this.close({
                id,
                reason,
                abort: false,
              });
              throw reason;
            }
          });
          await runWithSpan({ name: "send_peer_response" }, () => this.response(id, response));
        },
      );
    }
    return [id, request];
  }
  /**
   * @deprecated Please pass the `handleRequest` (second arg) function to the `message` method instead.
   */
  async response(id, response) {
    const signal = this.clientControllers.get(id)?.signal;
    if (!signal || signal.aborted) return;
    try {
      await this.send([id, MessageType.RESPONSE, response]);
      if (!signal.aborted && isAsyncIteratorObject(response.body))
        if (response.body instanceof HibernationEventIterator)
          response.body.hibernationCallback?.(id);
        else {
          const iterator = response.body;
          await resolveEventIterator(iterator, async (payload) => {
            if (signal.aborted) return "abort";
            await this.send([id, MessageType.EVENT_ITERATOR, payload]);
            return "next";
          });
        }
      this.close({
        id,
        abort: false,
      });
    } catch (reason) {
      this.close({
        id,
        reason,
        abort: false,
      });
      throw reason;
    }
  }
  close({ abort = true, ...options } = {}) {
    if (options.id === void 0) {
      if (abort) this.clientControllers.forEach((c) => c.abort(options.reason));
      this.clientControllers.clear();
    } else {
      if (abort) this.clientControllers.get(options.id)?.abort(options.reason);
      this.clientControllers.delete(options.id);
    }
    this.clientEventIteratorQueue.close(options);
  }
};
//#endregion
export { ServerPeer as n, ClientPeer as t };
