#!/usr/bin/env node
// Builds multi-speaker "conversation" WAVs from LibriSpeech (CC BY 4.0) for testing without glasses.
// Output: apps/even-hub/public/fixtures/dev/{conversation-a,conversation-b}.wav (gitignored). Needs ffmpeg.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const out = join(import.meta.dirname, "..", "apps", "even-hub", "public", "fixtures", "dev");
const work = join(tmpdir(), `irl-fixtures-${process.pid}`);
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });

async function rows(offset, length) {
  const url = `https://datasets-server.huggingface.co/rows?dataset=openslr/librispeech_asr&config=clean&split=validation&offset=${offset}&length=${length}`;
  const d = await (await fetch(url)).json();
  return d.rows.map((r) => ({ speaker: r.row.speaker_id, text: r.row.text, src: (Array.isArray(r.row.audio) ? r.row.audio[0] : r.row.audio).src }));
}

async function wav(row, i) {
  const flac = join(work, `${i}.flac`);
  writeFileSync(flac, Buffer.from(await (await fetch(row.src)).arrayBuffer()));
  const w = join(work, `${i}.wav`);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", flac, "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", w]);
  return w;
}

function concat(files, name) {
  const silence = join(work, "silence.wav");
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "0.7", "-sample_fmt", "s16", silence]);
  const list = join(work, `${name}.txt`);
  writeFileSync(list, files.flatMap((f) => [`file '${f}'`, `file '${silence}'`]).join("\n"));
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", join(out, `${name}.wav`)]);
}

const alice = await rows(0, 8); // speaker 2277
const bob = await rows(400, 4); // speaker 777
const carol = await rows(900, 4); // speaker 6313
let n = 0;
const a = await Promise.all(alice.map((r) => wav(r, n++)));
const b = await Promise.all(bob.map((r) => wav(r, n++)));
const c = await Promise.all(carol.map((r) => wav(r, n++)));
// A: Alice and Bob alternate. B (later conversation): Alice returns with Carol.
concat([a[0], b[0], a[1], b[1], a[2], b[2], a[3], b[3]], "conversation-a");
concat([c[0], a[4], c[1], a[5], c[2], a[6], c[3], a[7]], "conversation-b");
writeFileSync(join(out, "README.txt"), `LibriSpeech clean validation (CC BY 4.0). Speakers: A=${alice[0].speaker} (Alice), B=${bob[0].speaker} (Bob), C=${carol[0].speaker} (Carol).\n`);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${out}/conversation-a.wav and conversation-b.wav`);
