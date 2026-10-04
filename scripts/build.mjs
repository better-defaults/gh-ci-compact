import { chmod, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", {
  recursive: true,
  force: true,
});

await mkdir("dist", {
  recursive: true,
});

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  legalComments: "none",
  banner: {
    js: "#!/usr/bin/env node",
  },
});

await chmod("dist/cli.js", 0o755);
