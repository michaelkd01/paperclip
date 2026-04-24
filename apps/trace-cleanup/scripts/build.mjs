import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/bundle.mjs",
  external: [
    "postgres",
    "@aws-sdk/*",
    "drizzle-orm",
    "drizzle-orm/*",
    "embedded-postgres",
    "@embedded-postgres/*",
    "crypto",
    "net",
    "fs",
    "fs/promises",
    "path",
    "os",
    "node:*",
  ],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

console.log("  dist/bundle.mjs built");
