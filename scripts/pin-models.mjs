#!/usr/bin/env node
// Pins every catalog repo to its current commit and records size + SHA-256 for each catalog file.
// Usage: pnpm pin-models   (then review the diff of packages/provider-local/src/catalog.lock.json)
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const { CATALOG } = await import("../packages/provider-local/src/catalog.ts");
const out = { generatedAt: new Date().toISOString(), repos: {}, urls: {} };
const byRepo = new Map();
for (const e of CATALOG) {
  if (e.manifest.source.type !== "hf" || !e.manifest.files.length) continue;
  const repo = e.manifest.source.repo;
  byRepo.set(repo, new Set([...(byRepo.get(repo) ?? []), ...e.manifest.files.map((f) => f.path)]));
}
for (const [repo, wanted] of byRepo) {
  const info = await (await fetch(`https://huggingface.co/api/models/${repo}`)).json();
  if (!info.sha) {
    console.warn(`skip ${repo}: ${JSON.stringify(info).slice(0, 120)}`);
    continue;
  }
  const tree = await (await fetch(`https://huggingface.co/api/models/${repo}/tree/${info.sha}?recursive=true`)).json();
  const files = [];
  for (const path of wanted) {
    const node = tree.find((f) => f.path === path);
    if (!node) continue; // optional file (e.g. a dtype this repo doesn't ship)
    let sha256 = node.lfs?.oid ?? null;
    if (!sha256) {
      // Small non-LFS files: hash the bytes at the pinned revision.
      const body = Buffer.from(await (await fetch(`https://huggingface.co/${repo}/resolve/${info.sha}/${path}`)).arrayBuffer());
      sha256 = createHash("sha256").update(body).digest("hex");
    }
    files.push({ path, size: node.lfs?.size ?? node.size, sha256 });
  }
  out.repos[repo] = { repo, revision: info.sha, files };
  console.log(`${repo}@${info.sha.slice(0, 8)}: ${files.length}/${wanted.size} files`);
}
// Plain URL sources (versioned paths, no commit): hash every file.
for (const e of CATALOG) {
  const src = e.manifest.source;
  if (src.type !== "url" || !e.manifest.files.length) continue;
  const files = [];
  for (const { path } of e.manifest.files) {
    const res = await fetch(`${src.baseUrl}/${path}`);
    if (!res.ok) throw new Error(`${src.baseUrl}/${path}: HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    files.push({ path, size: body.length, sha256: createHash("sha256").update(body).digest("hex") });
  }
  out.urls[src.baseUrl] = { baseUrl: src.baseUrl, files };
  console.log(`${src.baseUrl}: ${files.length} files`);
}
writeFileSync(new URL("../packages/provider-local/src/catalog.lock.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
