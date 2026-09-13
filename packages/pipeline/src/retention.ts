import type { BlobStore, Repository } from "@irl/storage";
import { deleteAudio } from "./post-processor";

/**
 * Three distinct deletions (plan.md §8, §14):
 * - deleteRecordingAudio: removes audio only; transcript, summary, attributions, and embeddings stay.
 * - deleteRecording: removes the recording and everything derived from it; people and voice profiles stay
 *   unless `removeVoiceSamples` also removes profile samples/prototypes sourced from it.
 * - forget voice: IdentityService.forgetVoice (profiles, prototypes, samples; optional labels).
 */
export async function deleteRecordingAudio(repo: Repository, blobs: BlobStore, recordingId: string): Promise<void> {
  await deleteAudio(repo, blobs, recordingId);
}

export async function deleteRecording(repo: Repository, blobs: BlobStore, recordingId: string, opts: { removeVoiceSamples: boolean }): Promise<{ removedSamples: number; removedPrototypes: number }> {
  let removedSamples = 0;
  let removedPrototypes = 0;
  if (opts.removeVoiceSamples) {
    for (const s of await repo.samplesForRecording(recordingId)) {
      if (s.clipPath) await blobs.delete(s.clipPath);
      await repo.deleteSample(s.id);
      removedSamples++;
    }
    for (const p of await repo.listProfiles()) {
      for (const proto of await repo.prototypesForProfile(p.id)) {
        if (proto.sourceRecordingId === recordingId) {
          await repo.deletePrototype(proto.id);
          removedPrototypes++;
        }
      }
    }
  }
  await deleteAudio(repo, blobs, recordingId).catch(() => undefined);
  await repo.deleteRecordingRows(recordingId);
  return { removedSamples, removedPrototypes };
}
