// Static client bundle for Vercel.
//
// Plain Bun.build (no space SDK): bundles client/src/main.tsx + theme.css
// (Tailwind v4 via bun-plugin-tailwind) into client/dist, then writes
// client/dist/index.html from client/index.html with the built asset paths.

import tailwindPlugin from "bun-plugin-tailwind";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, "client", "dist");

const result = await Bun.build({
  entrypoints: [join(root, "client", "src", "main.tsx")],
  outdir,
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [tailwindPlugin],
  naming: "[name].[ext]",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("client build failed");
}

const jsOut = result.outputs.find((o) => o.path.endsWith(".js"));
const cssOut = result.outputs.find((o) => o.path.endsWith(".css"));
if (!jsOut) throw new Error("client build produced no JS output");
const jsName = jsOut.path.split("/").pop();
const cssName = cssOut ? cssOut.path.split("/").pop() : null;

let html = readFileSync(join(root, "client", "index.html"), "utf8");
const builtTags =
  (cssName ? `<link rel="stylesheet" href="./${cssName}" />\n    ` : "") +
  `<script type="module" src="./${jsName}"></script>`;
if (!html.includes('<script src="./src/main.tsx" type="module"></script>')) {
  throw new Error("client/index.html no longer contains the expected main.tsx script tag");
}
html = html.replace('<script src="./src/main.tsx" type="module"></script>', builtTags);

mkdirSync(outdir, { recursive: true });
writeFileSync(join(outdir, "index.html"), html);

// Copy public assets (profile photo, project logos) into the build output.
const publicDir = join(root, "public");
try {
  for (const f of readdirSync(publicDir)) {
    copyFileSync(join(publicDir, f), join(outdir, f));
  }
} catch {
  // No public dir: the app falls back to the monogram avatar / color dots.
}
console.log(`built client/dist/${jsName}${cssName ? ` + ${cssName}` : ""} + index.html`);
