// Module hooks so a worker thread can import the app's worker sources the way Vite serves them to the app:
// TypeScript, extensionless relative imports, `?url` asset imports, and the browser build of transformers.js.
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("?url")) {
    const r = await nextResolve(specifier.slice(0, -4), context);
    return { url: `${r.url}?url`, shortCircuit: true };
  }
  if (specifier === "@huggingface/transformers") {
    // Same package, but the "default" (browser) export Vite gives the app instead of the "node" one.
    const node = await nextResolve(specifier, context);
    return { url: new URL("transformers.web.js", node.url).href, shortCircuit: true, format: "module" };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.startsWith("file:")) {
    for (const suffix of [".ts", "/index.ts"]) {
      const url = new URL(specifier + suffix, context.parentURL);
      if (fs.existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith("?url")) return { format: "module", source: `export default ${JSON.stringify(url.slice(0, -4))};`, shortCircuit: true };
  if (url.startsWith("file:") && url.endsWith(".ts")) {
    const source = stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), "utf8"), { mode: "transform", sourceUrl: url });
    return { format: "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}

export const loaderUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
