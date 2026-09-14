// Runs one of the app's ML workers (src/workers/*.worker.ts) unchanged inside a Node worker thread: its own
// module graph and WASM instance, messages over the same postMessage/onmessage contract as a web Worker.
import { register } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { importAsWeb, installWebEnv } from "./web-env.mjs";

register(new URL("./loader.mjs", import.meta.url));
installWebEnv(workerData.cacheDir);
globalThis.location = { href: workerData.module };
// A web Worker's name carries its ONNX Runtime build (ort-flavor.ts).
globalThis.name = workerData.name;
globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer ?? []);
// A web Worker queues messages until its script has run; the RPC server only installs onmessage at the end.
const early = [];
parentPort.on("message", (data) => (globalThis.onmessage ? globalThis.onmessage({ data }) : early.push(data)));
await importAsWeb(workerData.module);
for (const data of early.splice(0)) globalThis.onmessage?.({ data });
