import { registerHooks } from "node:module";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Reuse the installed Pi dependencies without npm install or source changes.
let root = process.env.PI_TEST_PACKAGE_ROOT;
if (!root) {
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    const executable = join(directory, "pi");
    if (!existsSync(executable)) continue;
    let candidate = dirname(realpathSync(executable));
    while (dirname(candidate) !== candidate) {
      const manifest = join(candidate, "package.json");
      if (existsSync(manifest) &&
          JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") {
        root = candidate;
        break;
      }
      candidate = dirname(candidate);
    }
    if (root) break;
  }
}
const piURL = root && pathToFileURL(join(root, "dist/index.js")).href;
registerHooks({ resolve(specifier, context, next) {
  if (piURL && ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"].includes(specifier)) {
    return next(specifier, { ...context, parentURL: piURL });
  }
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const url = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(url))) return next(url.href, context);
  }
  return next(specifier, context);
} });
const available = readdirSync(new URL("./", import.meta.url)).filter(name => name.endsWith(".test.ts")).sort();
const selected = process.argv.slice(2);
for (const file of selected) {
  if (!available.includes(file)) throw new Error(`Unknown test file: ${file}`);
}
for (const file of selected.length ? selected : available) {
  await import(new URL(file, import.meta.url));
}
