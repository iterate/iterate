import type { CallExpression, Identifier, VariableDeclarator } from "estree";
import { expectTypeOf, test } from "vitest";

import type { StrictPlugin } from "./types.ts";

test("infers listener node types from selector strings", () => {
  const plugin = {
    rules: {
      "typed-selectors": {
        create() {
          return {
            CallExpression(node) {
              expectTypeOf(node).not.toBeAny();
              expectTypeOf(node).toMatchTypeOf<CallExpression>();
            },
            "CallExpression[callee.type='Identifier']"(node) {
              expectTypeOf(node).not.toBeAny();
              expectTypeOf(node).toMatchTypeOf<CallExpression>();
            },
            "Identifier, VariableDeclarator"(node) {
              expectTypeOf(node).toExtend<VariableDeclarator | Identifier>();
              const { parent, ...rest } = node;
              expectTypeOf<VariableDeclarator>().toExtend<typeof rest>();
              expectTypeOf<Identifier>().toExtend<typeof rest>();
            },
            "Program Identifier, VariableDeclarator"(node) {
              expectTypeOf(node).toExtend<VariableDeclarator | Identifier>();
              const { parent, ...rest } = node;
              expectTypeOf<VariableDeclarator>().toExtend<typeof rest>();
              expectTypeOf<Identifier>().toExtend<typeof rest>();
            },
            "Program Identifier:exit, Program VariableDeclarator:exit"(node) {
              expectTypeOf(node).toExtend<VariableDeclarator | Identifier>();
              const { parent, ...rest } = node;
              expectTypeOf<VariableDeclarator>().toExtend<typeof rest>();
              expectTypeOf<Identifier>().toExtend<typeof rest>();
            },
            "Identifier:exit,VariableDeclarator:exit"(node) {
              expectTypeOf(node).toExtend<VariableDeclarator | Identifier>();
              const { parent, ...rest } = node;
              expectTypeOf<VariableDeclarator>().toExtend<typeof rest>();
              expectTypeOf<Identifier>().toExtend<typeof rest>();
            },
            "Identifier:exit,VariableDeclarator:exit,CallExpression:exit"(node) {
              expectTypeOf(node).toExtend<VariableDeclarator | Identifier | CallExpression>();
              const { parent, ...rest } = node;
              expectTypeOf<VariableDeclarator>().toExtend<typeof rest>();
              expectTypeOf<Identifier>().toExtend<typeof rest>();
              expectTypeOf<CallExpression>().toExtend<typeof rest>();
            },
            "Identifier VariableDeclarator"(node) {
              expectTypeOf(node).not.toBeAny();
              expectTypeOf(node).toMatchTypeOf<VariableDeclarator>();
            },
            "Identifier VariableDeclarator:exit"(node) {
              expectTypeOf(node).not.toBeAny();
              expectTypeOf(node).toMatchTypeOf<VariableDeclarator>();
            },
            "Program Identifier VariableDeclarator"(node) {
              expectTypeOf(node).not.toBeAny();
              expectTypeOf(node).toMatchTypeOf<VariableDeclarator>();
            },
            "VariableDeclarator:exit[init.type='CallExpression']"(node) {
              expectTypeOf(node).not.toBeAny();
              expectTypeOf(node).toMatchTypeOf<VariableDeclarator>();
            },
          };
        },
      },
    },
  } satisfies StrictPlugin;

  void plugin;
});
