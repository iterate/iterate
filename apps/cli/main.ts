#!/usr/bin/env npx tsx
/**
 * Iterate CLI Entry Point
 */
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { cli, cliLayer } from "./cli.ts";

const program = Effect.suspend(() => cli(process.argv.slice(2)));

const runnable = program.pipe(Effect.provide(cliLayer));

NodeRuntime.runMain(runnable);
