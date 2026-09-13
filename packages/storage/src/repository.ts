import {
  KeyedMutex,
  type Person,
  type Recording,
  type RecordingState,
  type SpeakerAttribution,
  type SpeakerCluster,
  type SpeakerTurn,
  type SummaryRecord,
  type TranscriptToken,
  type VoicePrototype,
  type VoiceProfile,
  type VoiceSample,
  type VoiceWindow,
} from "@irl/domain";
import type { TableStore } from "./table-store";

export type ChunkCodec = "pcm_s16le" | "opus";
/** durable: sealed with the persisted master key; ephemeral: sealed with an in-memory key (non-persisted mode). */
export type KeyKind = "durable" | "ephemeral";

export interface AudioChunkRow {
  recordingId: string;
  sequence: number;
  startSample: number;
  endSample: number;
  codec: ChunkCodec;
  path: string;
  byteLength: number;
  /** CRC-32 of the stored (sealed) bytes. */
  checksum: number;
  keyKind: KeyKind;
  verified: boolean;
  createdAt: string;
}

export type ProviderRunKind = "live" | "final-stt" | "diarization-refine" | "identity" | "summary" | "reprocess";

export interface ProviderRun {
  id: string;
  recordingId: string;
  provider: string;
  kind: ProviderRunKind;
  config: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
  state: "running" | "finished" | "failed" | "aborted";
  error: string | null;
  resume: Record<string, unknown> | null;
}

export type OperationKind = "attribute" | "enroll" | "merge-people" | "forget-voice";

export interface OperationRow {
  id: string;
  kind: OperationKind;
  recordingId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  undone: boolean;
}

const bySample = <T extends { startSample: number }>(a: T, b: T) => a.startSample - b.startSample;

/** Typed repositories over either backend (plan.md §4 `Repository`). */
export class Repository {
  private readonly mutex = new KeyedMutex();

  constructor(readonly store: TableStore) {}

  get backend() {
    return this.store.backend;
  }

  // Recordings ---------------------------------------------------------------------------------

  putRecording(r: Recording): Promise<void> {
    return this.store.put("recordings", r);
  }

  getRecording(id: string): Promise<Recording | undefined> {
    return this.store.get<Recording>("recordings", [id]);
  }

  async listRecordings(): Promise<Recording[]> {
    return (await this.store.all<Recording>("recordings")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async recordingsInStates(states: readonly RecordingState[]): Promise<Recording[]> {
    const rows = await Promise.all(states.map((s) => this.store.where<Recording>("recordings", ["state"], [s])));
    return rows.flat();
  }

  /** Read-modify-write under a per-recording lock so concurrent patches never lose fields. */
  updateRecording(id: string, patch: Partial<Recording> | ((r: Recording) => Partial<Recording>)): Promise<Recording> {
    return this.mutex.run(`recording:${id}`, async () => {
      const cur = await this.getRecording(id);
      if (!cur) throw new Error(`recording ${id} not found`);
      const next = { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) };
      await this.putRecording(next);
      return next;
    });
  }

  // Audio chunks -------------------------------------------------------------------------------

  putChunk(c: AudioChunkRow): Promise<void> {
    return this.store.put("audio_chunks", c);
  }

  async listChunks(recordingId: string): Promise<AudioChunkRow[]> {
    return (await this.store.where<AudioChunkRow>("audio_chunks", ["recordingId"], [recordingId])).sort((a, b) => a.sequence - b.sequence);
  }

  deleteChunk(recordingId: string, sequence: number): Promise<void> {
    return this.store.delete("audio_chunks", [recordingId, sequence]);
  }

  deleteChunks(recordingId: string): Promise<void> {
    return this.store.deleteWhere("audio_chunks", ["recordingId"], [recordingId]);
  }

  // Transcript ---------------------------------------------------------------------------------

  putTokens(tokens: readonly TranscriptToken[]): Promise<void> {
    return this.store.putMany("transcript_tokens", tokens);
  }

  async listTokens(recordingId: string): Promise<TranscriptToken[]> {
    return (await this.store.where<TranscriptToken>("transcript_tokens", ["recordingId"], [recordingId])).sort(bySample);
  }

  async deleteTokens(recordingId: string, filter: (t: TranscriptToken) => boolean = () => true): Promise<void> {
    const rows = await this.listTokens(recordingId);
    await this.store.deleteMany("transcript_tokens", rows.filter(filter).map((t) => [t.id]));
  }

  putTurns(turns: readonly SpeakerTurn[]): Promise<void> {
    return this.store.putMany("speaker_turns", turns);
  }

  async listTurns(recordingId: string): Promise<SpeakerTurn[]> {
    return (await this.store.where<SpeakerTurn>("speaker_turns", ["recordingId"], [recordingId])).sort(bySample);
  }

  async deleteTurns(recordingId: string, filter: (t: SpeakerTurn) => boolean = () => true): Promise<void> {
    const rows = await this.listTurns(recordingId);
    await this.store.deleteMany("speaker_turns", rows.filter(filter).map((t) => [t.id]));
  }

  putCluster(c: SpeakerCluster): Promise<void> {
    return this.store.put("speaker_clusters", c);
  }

  async listClusters(recordingId: string): Promise<SpeakerCluster[]> {
    return (await this.store.where<SpeakerCluster>("speaker_clusters", ["recordingId"], [recordingId])).sort((a, b) => a.ordinal - b.ordinal);
  }

  putWindows(windows: readonly VoiceWindow[]): Promise<void> {
    return this.store.putMany("voice_windows", windows);
  }

  async deleteWindows(recordingId: string): Promise<void> {
    await this.store.deleteWhere("voice_windows", ["recordingId"], [recordingId]);
  }

  async deleteClusters(recordingId: string): Promise<void> {
    await this.store.deleteWhere("speaker_clusters", ["recordingId"], [recordingId]);
  }

  async listWindows(recordingId: string): Promise<VoiceWindow[]> {
    return (await this.store.where<VoiceWindow>("voice_windows", ["recordingId"], [recordingId])).sort(bySample);
  }

  // People and identity ------------------------------------------------------------------------

  putAttribution(a: SpeakerAttribution): Promise<void> {
    return this.store.put("speaker_attributions", a);
  }

  listAttributions(recordingId: string): Promise<SpeakerAttribution[]> {
    return this.store.where<SpeakerAttribution>("speaker_attributions", ["recordingId"], [recordingId]);
  }

  attributionsForPerson(personId: string): Promise<SpeakerAttribution[]> {
    return this.store.where<SpeakerAttribution>("speaker_attributions", ["personId"], [personId]);
  }

  attributionsForOperation(operationId: string): Promise<SpeakerAttribution[]> {
    return this.store.where<SpeakerAttribution>("speaker_attributions", ["operationId"], [operationId]);
  }

  putPerson(p: Person): Promise<void> {
    return this.store.put("people", p);
  }

  getPerson(id: string): Promise<Person | undefined> {
    return this.store.get<Person>("people", [id]);
  }

  async listPeople(): Promise<Person[]> {
    return (await this.store.all<Person>("people")).sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  deletePerson(id: string): Promise<void> {
    return this.store.delete("people", [id]);
  }

  putProfile(p: VoiceProfile): Promise<void> {
    return this.store.put("voice_profiles", p);
  }

  profilesForPerson(personId: string): Promise<VoiceProfile[]> {
    return this.store.where<VoiceProfile>("voice_profiles", ["personId"], [personId]);
  }

  listProfiles(): Promise<VoiceProfile[]> {
    return this.store.all<VoiceProfile>("voice_profiles");
  }

  deleteProfile(id: string): Promise<void> {
    return this.store.delete("voice_profiles", [id]);
  }

  putPrototype(p: VoicePrototype): Promise<void> {
    return this.store.put("voice_prototypes", p);
  }

  prototypesForProfile(profileId: string): Promise<VoicePrototype[]> {
    return this.store.where<VoicePrototype>("voice_prototypes", ["profileId"], [profileId]);
  }

  prototypesForOperation(operationId: string): Promise<VoicePrototype[]> {
    return this.store.where<VoicePrototype>("voice_prototypes", ["operationId"], [operationId]);
  }

  deletePrototype(id: string): Promise<void> {
    return this.store.delete("voice_prototypes", [id]);
  }

  putSample(s: VoiceSample): Promise<void> {
    return this.store.put("voice_samples", s);
  }

  samplesForProfile(profileId: string): Promise<VoiceSample[]> {
    return this.store.where<VoiceSample>("voice_samples", ["profileId"], [profileId]);
  }

  samplesForRecording(recordingId: string): Promise<VoiceSample[]> {
    return this.store.where<VoiceSample>("voice_samples", ["recordingId"], [recordingId]);
  }

  samplesForOperation(operationId: string): Promise<VoiceSample[]> {
    return this.store.where<VoiceSample>("voice_samples", ["operationId"], [operationId]);
  }

  deleteSample(id: string): Promise<void> {
    return this.store.delete("voice_samples", [id]);
  }

  // Summaries, runs, operations, settings ------------------------------------------------------

  putSummary(s: SummaryRecord): Promise<void> {
    return this.store.put("summaries", s);
  }

  getSummary(recordingId: string): Promise<SummaryRecord | undefined> {
    return this.store.get<SummaryRecord>("summaries", [recordingId]);
  }

  putRun(r: ProviderRun): Promise<void> {
    return this.store.put("provider_runs", r);
  }

  async listRuns(recordingId: string): Promise<ProviderRun[]> {
    return (await this.store.where<ProviderRun>("provider_runs", ["recordingId"], [recordingId])).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  updateRun(id: string, patch: Partial<ProviderRun>): Promise<void> {
    return this.mutex.run(`run:${id}`, async () => {
      const cur = await this.store.get<ProviderRun>("provider_runs", [id]);
      if (cur) await this.putRun({ ...cur, ...patch });
    });
  }

  putOperation(o: OperationRow): Promise<void> {
    return this.store.put("operations", o);
  }

  getOperation(id: string): Promise<OperationRow | undefined> {
    return this.store.get<OperationRow>("operations", [id]);
  }

  async listOperations(): Promise<OperationRow[]> {
    return (await this.store.all<OperationRow>("operations")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    return (await this.store.get<{ key: string; value: T }>("settings", [key]))?.value;
  }

  putSetting(key: string, value: unknown): Promise<void> {
    return this.store.put("settings", { key, value });
  }

  /**
   * Deletes a recording and everything derived from it. Voice profiles are untouched unless the caller
   * separately removes samples sourced from this recording (plan.md §8). Children go first so an
   * interrupted delete leaves a visible recording that can be deleted again.
   */
  async deleteRecordingRows(recordingId: string): Promise<void> {
    await this.store.deleteWhere("transcript_tokens", ["recordingId"], [recordingId]);
    await this.store.deleteWhere("speaker_turns", ["recordingId"], [recordingId]);
    await this.store.deleteWhere("speaker_clusters", ["recordingId"], [recordingId]);
    await this.store.deleteWhere("voice_windows", ["recordingId"], [recordingId]);
    await this.store.deleteWhere("speaker_attributions", ["recordingId"], [recordingId]);
    await this.store.deleteWhere("provider_runs", ["recordingId"], [recordingId]);
    await this.store.deleteWhere("audio_chunks", ["recordingId"], [recordingId]);
    await this.store.deleteWhere("operations", ["recordingId"], [recordingId]);
    await this.store.delete("summaries", [recordingId]);
    await this.store.delete("recordings", [recordingId]);
  }
}
