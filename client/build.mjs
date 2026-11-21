// Bundle the client CLI into client/dist/cli.mjs. Quiet on success.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
await build({
  entryPoints: [`${root}src/cli.ts`],
  outfile: `${root}dist/cli.mjs`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  logLevel: "warning",
});
