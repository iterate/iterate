import { c as createServerRpc } from "./createServerRpc--GzqEi4f.js";
import { a0 as createServerFn } from "./worker-entry-Bt0TXpOD.js";
import "node:async_hooks";
import "node:stream/web";
import "node:stream";
const getCount_createServerFn_handler = createServerRpc(
  {
    id: "380e4f27c86b2e828107a0454e2715b4169bf11b02de11d0dc9ad75de7d85a7e",
    name: "getCount",
    filename: "src/routes/counter.tsx",
  },
  (opts) => getCount.__executeServer(opts),
);
const getCount = createServerFn({
  method: "GET",
}).handler(getCount_createServerFn_handler, async () => {
  return {
    count: 0,
  };
});
export { getCount_createServerFn_handler };
