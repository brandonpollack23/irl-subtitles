import {
  activeAttributions,
  bytesToFloat32,
  cosine,
  decideMatch,
  Emitter,
  float32ToBytes,
  float32ToPcm,
  meanVector,
  newId,
  nowIso,
  overlap,
  pcmToFloat32,
  policyFor,
  rangeDurationMs,
  resolveCluster,
  type CandidateProfile,
  type ClusterEvidence,
  type ClusterId,
  type MatchDecision,
  type Person,
  type Settings,
  type SpeakerAttribution,
  type SpeakerCluster,
  type TimeRange,
  type VoiceEmbedding,
  type VoicePrototype,
  type VoiceProfile,
  type VoiceSample,
  type VoiceWindow,
} from "@irl/domain";
import type { RecordingAudio } from "@irl/capture";
import type { BlobStore, OperationRow, Repository, Sealer } from "@irl/storage";

export interface AssignArgs {
  recordingId: string;
  clusterId: ClusterId;
  /** Existing person, a new person, or null for an explicit "unknown" correction. */
  person: { id: string } | { fullName: string; shortName?: string } | null;
  learnVoice: boolean;
}

export interface IdentityChange {
  recordingId?: string;
  personId?: string;
}

const MAX_PROTOTYPES = 8;
const CLIP_MAX_MS = 12_000;

export class IdentityService {
  readonly changes = new Emitter<IdentityChange>();
  private candidateCache = new Map<string, CandidateProfile[]>();

  constructor(
    private readonly repo: Repository,
    private readonly blobs: BlobStore,
    private readonly sealer: Sealer,
    private readonly audio: RecordingAudio,
    private readonly settings: () => Settings,
    /** Embeds audio with a catalog model; used for re-embedding clips after a model change. */
    private readonly embed: (modelId: string, windows: { samples: Float32Array; range: TimeRange }[]) => Promise<VoiceEmbedding[]>,
  ) {}

  private invalidate(): void {
    this.candidateCache.clear();
  }

  async sealVector(v: Float32Array): Promise<Uint8Array> {
    return this.sealer.seal(float32ToBytes(v));
  }

  async openVector(sealed: Uint8Array): Promise<Float32Array> {
    return bytesToFloat32(await this.sealer.open(sealed));
  }

  // Candidates and matching ---------------------------------------------------------------------

  async candidates(embeddingSpace: string): Promise<CandidateProfile[]> {
    const cached = this.candidateCache.get(embeddingSpace);
    if (cached) return cached;
    const profiles = (await this.repo.listProfiles()).filter((p) => p.embeddingSpace === embeddingSpace);
    const out: CandidateProfile[] = [];
    for (const p of profiles) {
      const protos = await this.repo.prototypesForProfile(p.id);
      out.push({ personId: p.personId, embeddingSpace, needsReenrollment: p.needsReenrollment, prototypes: await Promise.all(protos.map((x) => this.openVector(x.sealedVector))) });
    }
    this.candidateCache.set(embeddingSpace, out);
    return out;
  }

  private async clusterWindows(recordingId: string, clusterId: ClusterId): Promise<VoiceWindow[]> {
    const clusters = new Map((await this.repo.listClusters(recordingId)).map((c) => [c.clusterId, c]));
    return (await this.repo.listWindows(recordingId)).filter((w) => resolveCluster(clusters, w.clusterId) === clusterId);
  }

  async evidence(recordingId: string, clusterId: ClusterId, windows?: readonly VoiceWindow[]): Promise<ClusterEvidence | null> {
    const rows = windows ?? (await this.clusterWindows(recordingId, clusterId));
    if (!rows.length) return null;
    const turns = await this.repo.listTurns(recordingId);
    const others = turns.filter((t) => t.clusterId !== clusterId);
    return {
      clusterId,
      embeddingSpace: rows[0]!.embeddingSpace,
      windows: await Promise.all(
        rows.map(async (w) => ({
          vector: await this.openVector(w.sealedVector),
          durationMs: rangeDurationMs(w),
          quality: w.quality,
          overlap: others.some((t) => overlap(t, w) > (w.endSample - w.startSample) * 0.25),
        })),
      ),
    };
  }

  /**
   * Applies a match decision: accepted → auto attribution (never over a manual one); below threshold →
   * candidate on the cluster ("Possibly X"); a previously auto-accepted cluster that no longer passes is
   * returned to unknown. Provisional provider speaker labels never reach profiles.
   */
  async applyDecision(recordingId: string, decision: MatchDecision): Promise<void> {
    const rows = (await this.repo.listAttributions(recordingId)).filter((a) => a.clusterId === decision.clusterId);
    const active = activeAttributions(rows).get(decision.clusterId);
    const cluster = (await this.repo.listClusters(recordingId)).find((c) => c.clusterId === decision.clusterId);
    if (active?.source === "manual") return;
    if (decision.status === "accepted" && decision.best) {
      if (active?.personId !== decision.best.personId) {
        await this.repo.putAttribution({
          id: newId("attr"), recordingId, clusterId: decision.clusterId, personId: decision.best.personId, confidence: decision.best.score,
          source: "auto", revision: nextRevision(rows), operationId: newId("auto"), createdAt: nowIso(), undone: false,
        });
      }
      if (cluster) await this.repo.putCluster(stripCandidate(cluster));
    } else {
      if (active?.source === "auto") await this.repo.putAttribution({ ...active, undone: true });
      if (cluster) {
        const cand = decision.status === "candidate" && decision.best ? { candidatePersonId: decision.best.personId, candidateScore: decision.best.score } : {};
        await this.repo.putCluster({ ...stripCandidate(cluster), ...cand });
      }
    }
    this.changes.emit({ recordingId });
  }

  async evaluateCluster(recordingId: string, clusterId: ClusterId, windows?: readonly VoiceWindow[]): Promise<MatchDecision | null> {
    const ev = await this.evidence(recordingId, clusterId, windows);
    if (!ev) return null;
    const policy = policyFor(ev.embeddingSpace, this.settings().matchPolicies);
    return decideMatch(ev, await this.candidates(ev.embeddingSpace), policy);
  }

  async identifyRecording(recordingId: string): Promise<MatchDecision[]> {
    const clusters = (await this.repo.listClusters(recordingId)).filter((c) => !c.mergedInto);
    const windows = await this.repo.listWindows(recordingId);
    const map = new Map(clusters.map((c) => [c.clusterId, c]));
    const out: MatchDecision[] = [];
    for (const c of clusters) {
      const mine = windows.filter((w) => resolveCluster(map, w.clusterId) === c.clusterId);
      const d = await this.evaluateCluster(recordingId, c.clusterId, mine);
      if (d) {
        await this.applyDecision(recordingId, d);
        out.push(d);
      }
    }
    return out;
  }

  /** Ranked people for the speaker sheet: best score first, then everyone else alphabetically. */
  async likelyPeople(recordingId: string, clusterId: ClusterId): Promise<{ person: Person; score: number | null }[]> {
    const people = await this.repo.listPeople();
    const ev = await this.evidence(recordingId, clusterId);
    const scores = new Map<string, number>();
    if (ev) {
      const agg = meanVector(ev.windows.map((w) => w.vector));
      for (const c of await this.candidates(ev.embeddingSpace)) {
        if (c.needsReenrollment || !c.prototypes.length) continue;
        scores.set(c.personId, Math.max(scores.get(c.personId) ?? -1, ...c.prototypes.map((p) => cosine(agg, p))));
      }
    }
    return people
      .map((person) => ({ person, score: scores.get(person.id) ?? null }))
      .sort((a, b) => (b.score ?? -2) - (a.score ?? -2) || a.person.fullName.localeCompare(b.person.fullName));
  }

  // Corrections and enrollment ----------------------------------------------------------------

  async createPerson(fullName: string, shortName?: string): Promise<Person> {
    const now = nowIso();
    const person: Person = { id: newId("person"), fullName: fullName.trim(), ...(shortName?.trim() ? { shortName: shortName.trim() } : {}), createdAt: now, updatedAt: now };
    if (!person.fullName) throw new Error("A full name is required");
    await this.repo.putPerson(person);
    this.changes.emit({ personId: person.id });
    return person;
  }

  async updatePerson(id: string, patch: { fullName?: string; shortName?: string | null }): Promise<Person> {
    const cur = await this.repo.getPerson(id);
    if (!cur) throw new Error("person not found");
    const next: Person = { ...cur, updatedAt: nowIso() };
    if (patch.fullName !== undefined) {
      if (!patch.fullName.trim()) throw new Error("A full name is required");
      next.fullName = patch.fullName.trim();
    }
    if (patch.shortName !== undefined) {
      if (patch.shortName?.trim()) next.shortName = patch.shortName.trim();
      else delete next.shortName;
    }
    await this.repo.putPerson(next);
    // Names are resolved at render time, so every transcript and summary reference updates at once.
    this.changes.emit({ personId: id });
    return next;
  }

  /**
   * plan.md §7.2: save the attribution immediately (all references re-render), then optionally learn the
   * voice from clean non-overlapping windows. Returns the operation id for Undo.
   */
  async assign(args: AssignArgs): Promise<{ operationId: string; personId: string | null }> {
    const operationId = newId("op");
    let personId: string | null = null;
    let createdPersonId: string | null = null;
    if (args.person && "id" in args.person) personId = args.person.id;
    else if (args.person) {
      const p = await this.createPerson(args.person.fullName, args.person.shortName);
      personId = createdPersonId = p.id;
    }
    const rows = (await this.repo.listAttributions(args.recordingId)).filter((a) => a.clusterId === args.clusterId);
    const attribution: SpeakerAttribution = {
      id: newId("attr"), recordingId: args.recordingId, clusterId: args.clusterId, personId, confidence: 1, source: "manual",
      revision: nextRevision(rows), operationId, createdAt: nowIso(), undone: false,
    };
    await this.repo.putAttribution(attribution);
    const op: OperationRow = { id: operationId, kind: args.learnVoice && personId ? "enroll" : "attribute", recordingId: args.recordingId, payload: { clusterId: args.clusterId, personId, createdPersonId, learnVoice: args.learnVoice }, createdAt: nowIso(), undone: false };
    await this.repo.putOperation(op);
    this.changes.emit({ recordingId: args.recordingId, personId: personId ?? undefined });
    if (args.learnVoice && personId) {
      const learned = await this.learnVoice(args.recordingId, args.clusterId, personId, operationId);
      await this.repo.putOperation({ ...op, payload: { ...op.payload, ...learned } });
    }
    return { operationId, personId };
  }

  private async learnVoice(recordingId: string, clusterId: ClusterId, personId: string, operationId: string): Promise<{ prototypes: number; samples: number; reason?: string }> {
    const ev = await this.evidence(recordingId, clusterId);
    const rows = await this.clusterWindows(recordingId, clusterId);
    if (!ev || !rows.length) return { prototypes: 0, samples: 0, reason: "no voice windows for this speaker" };
    const clean = ev.windows.map((w, i) => ({ ...w, row: rows[i]! })).filter((w) => !w.overlap && w.quality >= 0.5).sort((a, b) => b.quality - a.quality).slice(0, 20);
    if (!clean.length) return { prototypes: 0, samples: 0, reason: "no clean non-overlapping speech" };
    const space = ev.embeddingSpace;
    let profile = (await this.repo.profilesForPerson(personId)).find((p) => p.embeddingSpace === space);
    const now = nowIso();
    if (!profile) {
      profile = { id: newId("profile"), personId, embeddingSpace: space, needsReenrollment: false, createdAt: now, updatedAt: now };
    }
    await this.repo.putProfile({ ...profile, needsReenrollment: false, updatedAt: now });
    const vector = meanVector(clean.map((w) => w.vector), clean.map((w) => w.quality));
    const proto: VoicePrototype = {
      id: newId("proto"), profileId: profile.id, sealedVector: await this.sealVector(vector), quality: clean.reduce((n, w) => n + w.quality, 0) / clean.length,
      evidenceMs: clean.reduce((n, w) => n + w.durationMs, 0), sourceRecordingId: recordingId, operationId, createdAt: now,
    };
    await this.repo.putPrototype(proto);
    await this.prunePrototypes(profile.id);

    // Consented samples: best windows, with a sealed audio clip when audio is still available.
    let samples = 0;
    let clipBudget = CLIP_MAX_MS;
    for (const w of clean.slice(0, 4)) {
      const sample: VoiceSample = { id: newId("sample"), profileId: profile.id, recordingId, startSample: w.row.startSample, endSample: w.row.endSample, clipPath: null, consent: true, operationId, createdAt: now };
      if (this.settings().keepVoiceClips && clipBudget > 0) {
        try {
          const pcm = await this.audio.readRange(recordingId, w.row);
          if (pcm.some((v) => v !== 0)) {
            const path = `voice/${profile.id}/${sample.id}.pcm`;
            await this.blobs.write(path, await this.sealer.seal(float32ToPcm(pcm)));
            sample.clipPath = path;
            clipBudget -= w.durationMs;
          }
        } catch {
          /* audio no longer available: keep the sample without a clip */
        }
      }
      await this.repo.putSample(sample);
      samples++;
    }
    this.invalidate();
    this.changes.emit({ recordingId, personId });
    return { prototypes: 1, samples };
  }

  private async prunePrototypes(profileId: string): Promise<void> {
    const protos = await this.repo.prototypesForProfile(profileId);
    if (protos.length <= MAX_PROTOTYPES) return;
    const drop = [...protos].sort((a, b) => a.quality - b.quality || a.createdAt.localeCompare(b.createdAt)).slice(0, protos.length - MAX_PROTOTYPES);
    for (const p of drop) await this.repo.deletePrototype(p.id);
  }

  /** plan.md §7.2 step 6: removes the attribution and any profile samples the operation added. */
  async undo(operationId: string): Promise<void> {
    const op = await this.repo.getOperation(operationId);
    if (!op || op.undone) return;
    if (op.kind === "forget-voice") throw new Error("Forget voice cannot be undone");
    if (op.kind === "merge-people") {
      await this.undoMerge(op);
    } else {
      for (const a of await this.repo.attributionsForOperation(operationId)) await this.repo.putAttribution({ ...a, undone: true });
      for (const p of await this.repo.prototypesForOperation(operationId)) await this.repo.deletePrototype(p.id);
      for (const s of await this.repo.samplesForOperation(operationId)) {
        if (s.clipPath) await this.blobs.delete(s.clipPath);
        await this.repo.deleteSample(s.id);
      }
      this.invalidate();
      // Automatic matches that relied on the removed samples must not survive them.
      const personId = op.payload.personId as string | null | undefined;
      if (personId) await this.reevaluateAutoMatches(personId);
      const created = op.payload.createdPersonId as string | null | undefined;
      if (created) {
        const stillUsed = (await this.repo.attributionsForPerson(created)).some((a) => !a.undone);
        const profiles = await this.repo.profilesForPerson(created);
        const hasProtos = (await Promise.all(profiles.map((p) => this.repo.prototypesForProfile(p.id)))).some((x) => x.length > 0);
        if (!stillUsed && !hasProtos) {
          for (const p of profiles) await this.repo.deleteProfile(p.id);
          await this.repo.deletePerson(created);
        }
      }
    }
    await this.repo.putOperation({ ...op, undone: true });
    this.invalidate();
    this.changes.emit({ recordingId: op.recordingId ?? undefined });
  }

  async reevaluateAutoMatches(personId: string): Promise<void> {
    const autos = (await this.repo.attributionsForPerson(personId)).filter((a) => a.source === "auto" && !a.undone);
    for (const a of autos) {
      const current = activeAttributions((await this.repo.listAttributions(a.recordingId)).filter((x) => x.clusterId === a.clusterId)).get(a.clusterId);
      if (current?.id !== a.id) continue;
      const d = await this.evaluateCluster(a.recordingId, a.clusterId);
      if (d) await this.applyDecision(a.recordingId, d);
      else await this.repo.putAttribution({ ...a, undone: true });
    }
  }

  /** Manual merge: every attribution and profile of `removeId` moves to `keepId`. Undoable. */
  async mergePeople(keepId: string, removeId: string): Promise<string> {
    if (keepId === removeId) throw new Error("cannot merge a person into themselves");
    const removed = await this.repo.getPerson(removeId);
    if (!removed || !(await this.repo.getPerson(keepId))) throw new Error("person not found");
    const operationId = newId("op");
    const attributions = await this.repo.attributionsForPerson(removeId);
    for (const a of attributions) await this.repo.putAttribution({ ...a, personId: keepId });
    const profiles = await this.repo.profilesForPerson(removeId);
    const keepProfiles = await this.repo.profilesForPerson(keepId);
    const movedPrototypes: { id: string; fromProfile: string }[] = [];
    const movedProfiles: string[] = [];
    for (const p of profiles) {
      const target = keepProfiles.find((k) => k.embeddingSpace === p.embeddingSpace);
      if (target) {
        for (const proto of await this.repo.prototypesForProfile(p.id)) {
          await this.repo.putPrototype({ ...proto, profileId: target.id });
          movedPrototypes.push({ id: proto.id, fromProfile: p.id });
        }
        for (const s of await this.repo.samplesForProfile(p.id)) await this.repo.putSample({ ...s, profileId: target.id });
        await this.repo.deleteProfile(p.id);
      } else {
        await this.repo.putProfile({ ...p, personId: keepId });
        movedProfiles.push(p.id);
      }
    }
    await this.repo.deletePerson(removeId);
    await this.repo.putOperation({
      id: operationId, kind: "merge-people", recordingId: null, createdAt: nowIso(), undone: false,
      payload: { keepId, removed, attributionIds: attributions.map((a) => a.id), movedProfiles, movedPrototypes, profileSnapshots: profiles },
    });
    this.invalidate();
    this.changes.emit({ personId: keepId });
    return operationId;
  }

  private async undoMerge(op: OperationRow): Promise<void> {
    const removed = op.payload.removed as Person;
    await this.repo.putPerson(removed);
    for (const id of op.payload.attributionIds as string[]) {
      const rows = await this.repo.attributionsForPerson(op.payload.keepId as string);
      const a = rows.find((r) => r.id === id);
      if (a) await this.repo.putAttribution({ ...a, personId: removed.id });
    }
    for (const pid of op.payload.movedProfiles as string[]) {
      const all = await this.repo.listProfiles();
      const p = all.find((x) => x.id === pid);
      if (p) await this.repo.putProfile({ ...p, personId: removed.id });
    }
    const snapshots = op.payload.profileSnapshots as VoiceProfile[];
    for (const m of op.payload.movedPrototypes as { id: string; fromProfile: string }[]) {
      const snap = snapshots.find((s) => s.id === m.fromProfile);
      if (!snap) continue;
      await this.repo.putProfile(snap);
      const all = await Promise.all((await this.repo.profilesForPerson(op.payload.keepId as string)).map((p) => this.repo.prototypesForProfile(p.id)));
      const proto = all.flat().find((p) => p.id === m.id);
      if (proto) await this.repo.putPrototype({ ...proto, profileId: m.fromProfile });
    }
  }

  /**
   * Forget voice (plan.md §11): deletes embeddings, prototypes, and stored samples. With keepLabels the
   * person and their names stay on past transcripts; without, their attributions are withdrawn.
   */
  async forgetVoice(personId: string, opts: { keepLabels: boolean }): Promise<void> {
    for (const p of await this.repo.profilesForPerson(personId)) {
      for (const proto of await this.repo.prototypesForProfile(p.id)) await this.repo.deletePrototype(proto.id);
      for (const s of await this.repo.samplesForProfile(p.id)) {
        if (s.clipPath) await this.blobs.delete(s.clipPath);
        await this.repo.deleteSample(s.id);
      }
      await this.blobs.deletePrefix(`voice/${p.id}/`);
      await this.repo.deleteProfile(p.id);
    }
    if (!opts.keepLabels) {
      for (const a of await this.repo.attributionsForPerson(personId)) if (!a.undone) await this.repo.putAttribution({ ...a, undone: true });
      await this.repo.deletePerson(personId);
    }
    await this.repo.putOperation({ id: newId("op"), kind: "forget-voice", recordingId: null, payload: { personId, keepLabels: opts.keepLabels }, createdAt: nowIso(), undone: false });
    this.invalidate();
    this.changes.emit({ personId });
  }

  async profileSummary(personId: string): Promise<{ profiles: { profile: VoiceProfile; prototypes: number; samples: number; clips: number; quality: number; evidenceMs: number }[] }> {
    const profiles = await this.repo.profilesForPerson(personId);
    return {
      profiles: await Promise.all(
        profiles.map(async (profile) => {
          const protos = await this.repo.prototypesForProfile(profile.id);
          const samples = await this.repo.samplesForProfile(profile.id);
          return {
            profile,
            prototypes: protos.length,
            samples: samples.length,
            clips: samples.filter((s) => s.clipPath).length,
            quality: protos.length ? protos.reduce((n, p) => n + p.quality, 0) / protos.length : 0,
            evidenceMs: protos.reduce((n, p) => n + p.evidenceMs, 0),
          };
        }),
      ),
    };
  }

  /**
   * plan.md §6.1: a new speaker-embedding model is a new embedding space. Re-embed each profile from its
   * retained clips; profiles without clips get a Needs re-enrollment profile and never auto-match.
   */
  async migrateEmbeddingSpace(modelId: string, newSpace: string): Promise<{ reembedded: number; needsReenrollment: number }> {
    const all = await this.repo.listProfiles();
    const byPerson = new Map<string, VoiceProfile[]>();
    for (const p of all) byPerson.set(p.personId, [...(byPerson.get(p.personId) ?? []), p]);
    let reembedded = 0;
    let needs = 0;
    for (const [personId, profiles] of byPerson) {
      if (profiles.some((p) => p.embeddingSpace === newSpace && !p.needsReenrollment)) continue;
      const clips = (await Promise.all(profiles.map((p) => this.repo.samplesForProfile(p.id)))).flat().filter((s) => s.clipPath);
      const now = nowIso();
      const target: VoiceProfile = profiles.find((p) => p.embeddingSpace === newSpace) ?? { id: newId("profile"), personId, embeddingSpace: newSpace, needsReenrollment: true, createdAt: now, updatedAt: now };
      const windows: { samples: Float32Array; range: TimeRange }[] = [];
      for (const s of clips) {
        const sealed = await this.blobs.read(s.clipPath!);
        if (!sealed) continue;
        try {
          windows.push({ samples: pcmToFloat32(await this.sealer.open(sealed)), range: s });
        } catch {
          /* unreadable clip */
        }
      }
      const embeddings = windows.length ? await this.embed(modelId, windows) : [];
      if (!embeddings.length) {
        await this.repo.putProfile({ ...target, needsReenrollment: true, updatedAt: now });
        needs++;
        continue;
      }
      await this.repo.putProfile({ ...target, needsReenrollment: false, updatedAt: now });
      const operationId = newId("reembed");
      await this.repo.putPrototype({
        id: newId("proto"), profileId: target.id, sealedVector: await this.sealVector(meanVector(embeddings.map((e) => e.vector))),
        quality: embeddings.reduce((n, e) => n + e.quality, 0) / embeddings.length, evidenceMs: embeddings.reduce((n, e) => n + rangeDurationMs(e), 0),
        sourceRecordingId: clips[0]!.recordingId, operationId, createdAt: now,
      });
      // Clips stay on their original profile rows; later migrations scan every profile of the person.
      reembedded++;
    }
    this.invalidate();
    this.changes.emit({});
    return { reembedded, needsReenrollment: needs };
  }
}

function nextRevision(rows: readonly SpeakerAttribution[]): number {
  return rows.reduce((m, r) => Math.max(m, r.revision), 0) + 1;
}

function stripCandidate(c: SpeakerCluster): SpeakerCluster {
  const { candidatePersonId: _a, candidateScore: _b, ...rest } = c;
  return rest;
}
