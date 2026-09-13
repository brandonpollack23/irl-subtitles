// Issues a locally trusted HTTPS certificate for the dev server with mkcert, covering
// localhost and every LAN address, so phone Chrome and Safari get a secure context.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "certs");
mkdirSync(dir, { recursive: true });
const lan = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === "IPv4" && !a.internal)
  .map((a) => a.address);
const names = ["localhost", "127.0.0.1", hostname(), `${hostname()}.local`, ...lan];

const run = (args) => execFileSync("mkcert", args, { stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
// No `mkcert -install`: the laptop's trust store doesn't matter, the phones' does.
try {
  run(["-key-file", join(dir, "key.pem"), "-cert-file", join(dir, "cert.pem"), ...names]);
} catch (e) {
  console.error(`mkcert failed (run \`mise install\` from the repo root for mkcert): ${e}`);
  process.exit(1);
}
console.log(`certificate for ${names.join(", ")} written to certs/`);
console.log(`install this CA on each phone: ${join(run(["-CAROOT"]), "rootCA.pem")}`);
