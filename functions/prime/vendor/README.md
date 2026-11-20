# Vendored QuickJS build

`qjs-wasi-reactor.wasm` is the WASI reactor build of QuickJS from the quickjs-ng
v0.18.0 GitHub release, unmodified. Spike S1 (#0011) tested this build.

- Source: https://github.com/quickjs-ng/quickjs/releases/download/v0.18.0/qjs-wasi-reactor.wasm
- SHA-256: `8afa5d73287af5573613e15d5e633e91d8e096b40676f424f104087bc1416678`

`src/repl/wasm.ts` checks this hash every time it loads the file. To upgrade,
replace the file, update the hash in `wasm.ts`, and re-run the REPL tests,
including the snapshot/restore tests. A snapshot only restores into the exact
build that made it.

The Prime bundle must ship this file next to `index.mjs`. Set `STZ_QJS_WASM`
to load it from another path.
