/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

/**
 * Plain constructor used when a mixin adds instance members.
 *
 * Example:
 *
 *   Constructor<InitializeMembers<RoomInit>>
 *
 * means "instances constructed by this class have initialize/assertInitialized".
 * Mixin result types intersect this with the wrapped base class so callers keep
 * the base statics and Cloudflare's normal `Base<Env>` extension style.
 */
export type Constructor<T = object> = abstract new (...args: any[]) => T;

/**
 * Constructor for a Durable Object class with an optional required Env shape
 * and optional accumulated members.
 *
 * This is deliberately small and shared by mixins so the common "must wrap a
 * DurableObject" constraint has one explanation and one implementation.
 */
export type DurableObjectConstructor<Env = unknown, Members = object> = abstract new (
  ...args: any[]
) => DurableObject<Env> & Members;
