import { nowIso, UNFINISHED_STATES, type Recording } from "@irl/domain";
import type { RecordingAudio } from "@irl/capture";
import type { BlobStore, Repository } from "@irl/storage";
import { deleteAudio } from "./post-processor";

export interface RecoveredRecording {
  recording: Recording;
  readableChunks: number;
  badChunks: number;
  recoveredSamples: number;
  audioLost: boolean;
}

/**
 * plan.md §9 Recovery: every relaunch is crash recovery. Unfinished sessions are verified chunk by chunk,
 * their cursor rebuilt from the last readable chunk, and marked interrupted for Finish processing / Discard.
 * Microphone capture is never resumed silently. Non-persisted audio from a dead process is unreadable
 * (its key died with it) and is deleted.
 */
export async function recoverInterrupted(
  repo: Repository,
  blobs: BlobStore,
  audio: RecordingAudio,
  activeRecordingId: string | null,
  /** True for recordings whose ephemeral key is still held by this process (e.g. queued post-processing). */
  liveEphemeral: (recordingId: string) => boolean = () => false,
): Promise<RecoveredRecording[]> {
  const out: RecoveredRecording[] = [];
  const candidates = (await repo.recordingsInStates(UNFINISHED_STATES)).filter((r) => r.id !== activeRecordingId);
  for (const rec of candidates) {
    const v = await audio.verify(rec.id);
    const audioLost = rec.audioRetention === "ephemeral" || v.readableChunks === 0;
    for (const bad of v.badChunks) {
      await blobs.delete(bad.path);
      await repo.deleteChunk(rec.id, bad.sequence);
    }
    if (rec.audioRetention === "ephemeral") await deleteAudio(repo, blobs, rec.id);
    const updated = await repo.updateRecording(rec.id, (r) => ({
      state: "interrupted",
      recoveryCursor: v.lastSample,
      totalSamples: Math.max(v.lastSample, audioLost ? r.totalSamples : 0),
      endedAt: r.endedAt ?? nowIso(),
      error: audioLost ? (rec.audioRetention === "ephemeral" ? "App closed during a non-persisted recording; audio was not saved" : "No readable audio was recovered") : null,
    }));
    out.push({ recording: updated, readableChunks: v.readableChunks, badChunks: v.badChunks.length, recoveredSamples: v.lastSample, audioLost });
  }
  // Any other scratch file belongs to a dead process: its key is gone, so it is unreadable noise.
  for (const path of await blobs.list("scratch/")) {
    const id = path.split("/")[1];
    if (id && id !== activeRecordingId && !liveEphemeral(id)) await blobs.delete(path);
  }
  return out;
}

export async function listInterrupted(repo: Repository): Promise<Recording[]> {
  return repo.recordingsInStates(["interrupted"]);
}
