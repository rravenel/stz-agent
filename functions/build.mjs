// Bundle each Lambda into functions/dist/<name>/index.mjs for the CDK stack
// (lambda.Code.from_asset("functions/dist/<name>")). Quiet on success.
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const functions = ["doorman", "prime", "com"];

rmSync(`${root}dist`, { recursive: true, force: true });
await Promise.all(
  functions.map((name) =>
    build({
      entryPoints: [`${root}${name}/src/index.ts`],
      outfile: `${root}dist/${name}/index.mjs`,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      sourcemap: true,
      // The Lambda Node.js runtime ships AWS SDK v3.
      external: ["@aws-sdk/*"],
      // ESM bundles still meet CommonJS deps; give them require().
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      logLevel: "warning",
    }),
  ),
);
