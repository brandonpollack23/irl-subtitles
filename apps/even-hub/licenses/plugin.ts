import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import type { LicenseNotice, LicensesFile } from "./types";

const TEXTS = join(import.meta.dirname, "texts");
const REPO = resolve(import.meta.dirname, "../../..");
const VENDOR = join(REPO, "vendor") + sep;
const NODE_MODULES = `${sep}node_modules${sep}`;

/**
 * License texts for packages whose npm tarball has none, or that another package inlines into its own bundle.
 * Texts are copied from each project's repository into licenses/texts.
 */
const PACKAGE_TEXTS: Record<string, { file?: string; license?: string; url: string }> = {
  "@irl/moonshine-wasm": { url: "https://github.com/moonshine-ai/moonshine" },
  "solid-js": { file: "solid.txt", url: "https://github.com/solidjs/solid" },
  "@solidjs/web": { file: "solid.txt", url: "https://github.com/solidjs/solid" },
  "onnxruntime-common": { file: "onnxruntime.txt", url: "https://github.com/microsoft/onnxruntime" },
  "onnxruntime-web": { file: "onnxruntime.txt", url: "https://github.com/microsoft/onnxruntime" },
  "@tursodatabase/database-common": { file: "turso.txt", url: "https://github.com/tursodatabase/turso" },
  "@tursodatabase/database-wasm-common": { file: "turso.txt", url: "https://github.com/tursodatabase/turso" },
  "@tursodatabase/database-wasm": { file: "turso.txt", url: "https://github.com/tursodatabase/turso" },
  "@napi-rs/wasm-runtime": { file: "napi-rs.txt", url: "https://github.com/napi-rs/napi-rs" },
  "@tybys/wasm-util": { file: "wasm-util.txt", url: "https://github.com/toyobayashi/wasm-util" },
  // Inlined into @huggingface/transformers' web build.
  "@huggingface/jinja": { file: "huggingface-js.txt", license: "MIT", url: "https://github.com/huggingface/huggingface.js" },
};

const ORT_WASM = "Built into ONNX Runtime Web's WebAssembly, and into Moonshine's as a reduced ONNX Runtime 1.23.2.";
const MOONSHINE_WASM = "Built into Moonshine's speech-to-text WebAssembly.";
const TURSO_WASM = "Built into Turso's WebAssembly database engine.";

/** Libraries compiled into WebAssembly binaries, included while the package that ships the binary is in the build. */
const COMPONENTS: readonly (Omit<LicenseNotice, "text"> & { files: string[]; with: string[] })[] = [
  { name: "ONNX Runtime third-party notices", version: "1.29.0", license: "Various", url: "https://github.com/microsoft/onnxruntime/blob/v1.29.0/ThirdPartyNotices.txt", note: ORT_WASM, files: ["onnxruntime-third-party-notices.txt"], with: ["onnxruntime-web", "@irl/moonshine-wasm"] },
  { name: "ONNX Runtime", version: "1.23.2", license: "MIT", url: "https://github.com/microsoft/onnxruntime", note: MOONSHINE_WASM, files: ["onnxruntime.txt"], with: ["@irl/moonshine-wasm"] },
  { name: "Emscripten", version: "", license: "MIT OR NCSA", url: "https://github.com/emscripten-core/emscripten", note: "Runtime code in the WebAssembly loaders for ONNX Runtime and Moonshine.", files: ["emscripten.txt"], with: ["onnxruntime-web", "@irl/moonshine-wasm"] },
  { name: "Eigen", version: "", license: "MPL-2.0", url: "https://gitlab.com/libeigen/eigen", note: `${MOONSHINE_WASM} Source code: https://gitlab.com/libeigen/eigen`, files: ["eigen-mpl2.txt"], with: ["@irl/moonshine-wasm"] },
  { name: "kaldi-native-fbank", version: "", license: "Apache-2.0", url: "https://github.com/csukuangfj/kaldi-native-fbank", note: MOONSHINE_WASM, files: ["kaldi-native-fbank.txt"], with: ["@irl/moonshine-wasm"] },
  { name: "KISS FFT", version: "", license: "BSD-3-Clause", url: "https://github.com/mborgerding/kissfft", note: MOONSHINE_WASM, files: ["kissfft.txt"], with: ["@irl/moonshine-wasm"] },
  { name: "JSON for Modern C++", version: "", license: "MIT", url: "https://github.com/nlohmann/json", note: MOONSHINE_WASM, files: ["nlohmann-json.txt"], with: ["@irl/moonshine-wasm"] },
  { name: "UTF8-CPP", version: "", license: "BSL-1.0", url: "https://github.com/nemtrif/utfcpp", note: MOONSHINE_WASM, files: ["utfcpp.txt"], with: ["@irl/moonshine-wasm"] },
  { name: "utf8proc", version: "", license: "MIT", url: "https://github.com/JuliaStrings/utf8proc", note: MOONSHINE_WASM, files: ["utf8proc.txt"], with: ["@irl/moonshine-wasm"] },
  // The dependencies Turso's own NOTICE.md lists for its core.
  { name: "crossbeam-skiplist", version: "", license: "MIT OR Apache-2.0", url: "https://github.com/crossbeam-rs/crossbeam", note: TURSO_WASM, files: ["crossbeam-skiplist-mit.txt"], with: ["@tursodatabase/database-wasm"] },
  { name: "libm", version: "", license: "MIT OR Apache-2.0", url: "https://github.com/rust-lang/libm", note: TURSO_WASM, files: ["libm-mit.txt"], with: ["@tursodatabase/database-wasm"] },
  { name: "pastey", version: "", license: "MIT OR Apache-2.0", url: "https://github.com/AS1100K/pastey", note: TURSO_WASM, files: ["pastey-mit.txt"], with: ["@tursodatabase/database-wasm"] },
  { name: "serde", version: "", license: "MIT OR Apache-2.0", url: "https://github.com/serde-rs/serde", note: TURSO_WASM, files: ["serde-mit.txt"], with: ["@tursodatabase/database-wasm"] },
  { name: "serde_json5", version: "", license: "Apache-2.0", url: "https://github.com/google/serde_json5", note: TURSO_WASM, files: ["serde_json5-apache.txt"], with: ["@tursodatabase/database-wasm"] },
];

/** transformers.js's Node backends: dependencies, but the web build never loads them. */
const NODE_ONLY = new Set(["onnxruntime-node", "sharp"]);

const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyrightnotice|thirdpartynotices?)([.-].*)?$/i;
/** esbuild's per-file comments in prebundled output, e.g. `// ../../node_modules/.pnpm/@huggingface+jinja@0.5.6/node_modules/@huggingface/jinja/dist/index.js`. */
const INLINED = /^\/\/ \S*node_modules\/\.pnpm\/([^/\s]+)\/node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//gm;

interface PackageJson {
  name?: string;
  version?: string;
  license?: string | { type: string };
  licenses?: { type: string }[];
  repository?: string | { url: string };
  homepage?: string;
  dependencies?: Record<string, string>;
}

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as PackageJson;
const text = (file: string) => readFileSync(join(TEXTS, file), "utf8").trim();

/** Third-party code only: installed packages and vendor/, not this repo's own apps and packages. */
const isThirdParty = (dir: string) => dir.includes(NODE_MODULES) || dir.startsWith(VENDOR);

function repoUrl(pkg: PackageJson): string | undefined {
  const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const url = raw?.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^github:/, "https://github.com/");
  return url?.startsWith("https://") ? url : pkg.homepage;
}

/** Tracks the third-party packages a build pulls in, across the main build and every worker build. */
class Collector {
  private readonly roots = new Map<string, string | null>();
  readonly dirs = new Set<string>();
  readonly inlined = new Map<string, string>();

  /** Nearest directory above `file` with a named package.json. */
  private root(file: string): string | null {
    let d = dirname(file);
    const seen: string[] = [];
    let found: string | null = null;
    while (true) {
      const cached = this.roots.get(d);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      seen.push(d);
      const pj = join(d, "package.json");
      if (existsSync(pj) && readJson(pj).name) {
        found = d;
        break;
      }
      const up = dirname(d);
      if (up === d) break;
      d = up;
    }
    for (const s of seen) this.roots.set(s, found);
    return found;
  }

  addFile(file: string): void {
    const path = file.split("?")[0]!;
    if (path.startsWith("\0") || !existsSync(path)) return;
    const dir = this.root(path);
    if (!dir || !isThirdParty(dir)) return;
    this.dirs.add(dir);
    if (dir.includes(NODE_MODULES) && /\.[cm]?js$/.test(path)) this.addInlined(readFileSync(path, "utf8"));
  }

  private addInlined(source: string): void {
    for (const [, store, name] of source.matchAll(INLINED)) {
      const installed = join(REPO, "node_modules", ".pnpm", store!, "node_modules", name!);
      if (existsSync(join(installed, "package.json"))) this.dirs.add(realpathSync(installed));
      else this.inlined.set(name!, store!.slice(name!.replace("/", "+").length + 1).split("_")[0]!);
    }
  }

  /** Every runtime dependency reachable from `dir` (dev server: there is no bundle to inspect). */
  addDependencies(dir: string, seen = new Set<string>()): void {
    if (seen.has(dir)) return;
    seen.add(dir);
    if (isThirdParty(dir)) this.dirs.add(dir);
    for (const name of Object.keys(readJson(join(dir, "package.json")).dependencies ?? {})) {
      if (NODE_ONLY.has(name)) continue;
      const dep = resolveDependency(dir, name);
      if (dep) this.addDependencies(dep, seen);
    }
  }

  file(onMissing: (message: string) => void): LicensesFile {
    const packages = new Map<string, LicenseNotice>();
    for (const dir of this.dirs) {
      const pkg = readJson(join(dir, "package.json"));
      const n = describePackage(dir, pkg, onMissing);
      packages.set(`${n.name}@${n.version}`, n);
    }
    for (const [name, version] of this.inlined) {
      const fallback = PACKAGE_TEXTS[name];
      if (!fallback?.license || !fallback.file) {
        onMissing(`${name}@${version} is inlined into another package; add its license to PACKAGE_TEXTS in licenses/plugin.ts`);
        continue;
      }
      packages.set(`${name}@${version}`, { name, version, license: fallback.license, url: fallback.url, text: text(fallback.file) });
    }
    const names = new Set([...packages.values()].map((p) => p.name));
    const components = COMPONENTS.filter((c) => c.with.some((n) => names.has(n))).map(({ files, with: _, ...c }) => ({ ...c, text: files.map(text).join("\n\n") }));
    return { packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)), components };
  }
}

function resolveDependency(from: string, name: string): string | null {
  for (let d = from; ; d = dirname(d)) {
    const candidate = join(d, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(d) === d) return null;
  }
}

function describePackage(dir: string, pkg: PackageJson, onMissing: (message: string) => void): LicenseNotice {
  const name = pkg.name!;
  const version = pkg.version ?? "";
  const fallback = PACKAGE_TEXTS[name];
  const files = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort((a, b) => Number(/^notice|^copyright/i.test(a)) - Number(/^notice|^copyright/i.test(b)) || a.localeCompare(b));
  const body = files.length ? files.map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n") : fallback?.file ? text(fallback.file) : "";
  const license = (typeof pkg.license === "string" ? pkg.license : pkg.license?.type) ?? pkg.licenses?.map((l) => l.type).join(" OR ") ?? fallback?.license ?? "";
  if (!body || !license) onMissing(`${name}@${version} has no ${body ? "license field" : "license file"}; add it to PACKAGE_TEXTS in licenses/plugin.ts`);
  const url = fallback?.url ?? repoUrl(pkg);
  return { name, version, license, ...(url ? { url } : {}), text: body };
}

/**
 * Writes `licenses.json` with the license of every third-party package whose code or assets end up in the build,
 * found from the main and worker module graphs and emitted asset sources, plus the libraries compiled into the
 * WebAssembly binaries. The build fails when a package has no license text. The dev server serves the same file
 * built from the runtime dependency tree instead.
 */
export function licenses(): { plugin: Plugin; worker: () => Plugin } {
  const collector = new Collector();
  const collect = (ctx: { getModuleIds(): IterableIterator<string> }) => {
    for (const id of ctx.getModuleIds()) collector.addFile(id);
  };
  let root = "";
  return {
    plugin: {
      name: "irl-licenses",
      configResolved(config) {
        root = config.root;
      },
      configureServer(server) {
        server.middlewares.use("/licenses.json", (_req, res) => {
          const dev = new Collector();
          dev.addDependencies(root);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(dev.file((m) => server.config.logger.warn(`[licenses] ${m}`))));
        });
      },
      buildEnd() {
        collect(this);
      },
      generateBundle(_options, bundle) {
        // Worker bundles are built while the main build transforms, so they are already collected here.
        for (const out of Object.values(bundle)) {
          if (out.type === "asset") for (const src of out.originalFileNames) collector.addFile(resolve(root, src));
        }
        const file = collector.file((m) => this.error(m));
        this.emitFile({ type: "asset", fileName: "licenses.json", source: JSON.stringify(file) });
      },
    },
    worker: () => ({
      name: "irl-licenses-worker",
      buildEnd() {
        collect(this);
      },
    }),
  };
}
