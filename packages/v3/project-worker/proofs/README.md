# The proof board

Live proofs against the deployed clean-room worker (`project-worker.iterate.workers.dev`).
Each suite creates a fresh `?ctx=` project, exercises one slice end to end, and prints
PASS/FAIL lines; `ALL PASS` + exit 0 is green. Run from this package (capnweb resolves from
node_modules):

    node proofs/prove_crisp1.mjs            # one suite
    for p in proofs/prove_*.mjs; do node $p & done; wait   # the whole board (hibernates are SLOW)

The thirteen-suite board: crisp1 push livestate ephemeral core userfacet restore facet1 edge
rich facetaddr slack ephemeralflood. Extras: hibernate/hibernate3 (multi-minute holds),
fetchdoor. `proof_sources.mjs` holds the demo module sources each suite seeds into plain kv
(`DURABLE=1 node proofs/prove_ephemeralflood.mjs` floods durable events instead of ephemeral).
