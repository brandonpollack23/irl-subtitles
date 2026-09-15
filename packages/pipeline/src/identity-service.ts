import {
  activeAttributions,
  bytesToFloat32,
  cosine,
  decideMatch,
  Emitter,
  float32ToBytes,
  concatBytes,
  float32ToPcm,
  isServiceVoiceSpace,
  meanVector,
  newId,
  nowIso,
  overlap,
  pcmToFloat32,
  policyFor,
  rangeDurationMs,
  resolveCluster,
  SAMPLE_RATE,
  serviceVoiceLabel,
  SPEECHMATICS_VOICE_SPACE,
  wavHeader,
  type CandidateProfile,
  type ClusterEvidence,
  type ClusterId,
  type MatchDecision,
  type Person,
  type ServiceSpeaker,
  type Settings,
  type SpeakerAttribution,
  type SpeakerCluster,
  type TimeRange,
  type VoiceEmbedding,
  type VoicePrototype,
  type VoiceProfile,
  type VoiceSample,
  type VoiceWindow,
  UserError,
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
/** Speechmatics accepts at most 50 identifiers per session. */
const MAX_SERVICE_IDENTIFIERS = 50;
/** Identifiers kept per enrolled prototype (a cluster can return several). */
const IDENTIFIERS_PER_PROTOTYPE = 4;

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
    /** Enrolls one voice with the speech service from a WAV of their clips; returns its identifiers (Speechmatics batch get_speakers). */
    private readonly serviceEnroll?: (wav: Uint8Array, language: string) => Promise<string[] | null>,
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
    // Service identifiers aren't vectors; they're matched by the service itself.
    if (isServiceVoiceSpace(embeddingSpace)) return [];
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
    return (await this.repo.listWindows(recordingId)).filter((w) => !isServiceVoiceSpace(w.embeddingSpace) && resolveCluster(clusters, w.clusterId) === clusterId);
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
   * returned to unknown. Provisional provider speaker labels never reach profiles. Returns the cluster row as
   * written, or null when the cluster was left alone (manual attribution, or no stored row).
   */
  async applyDecision(recordingId: string, decision: MatchDecision): Promise<SpeakerCluster | null> {
    const rows = (await this.repo.listAttributions(recordingId)).filter((a) => a.clusterId === decision.clusterId);
    const active = activeAttributions(rows).get(decision.clusterId);
    const cluster = (await this.repo.listClusters(recordingId)).find((c) => c.clusterId === decision.clusterId);
    if (active?.source === "manual") return null;
    let written: SpeakerCluster | null = null;
    if (decision.status === "accepted" && decision.best) {
      if (active?.personId !== decision.best.personId) {
        await this.repo.putAttribution({
          id: newId("attr"), recordingId, clusterId: decision.clusterId, personId: decision.best.personId, confidence: decision.best.score,
          source: "auto", revision: nextRevision(rows), operationId: newId("auto"), createdAt: nowIso(), undone: false,
        });
      }
      if (cluster) written = stripCandidate(cluster);
    } else {
      if (active?.source === "auto") await this.repo.putAttribution({ ...active, undone: true });
      if (cluster) {
        const cand = decision.status === "candidate" && decision.best ? { candidatePersonId: decision.best.personId, candidateScore: decision.best.score } : {};
        written = { ...stripCandidate(cluster), ...cand };
      }
    }
    if (written) await this.repo.putCluster(written);
    this.changes.emit({ recordingId });
    return written;
  }

  async evaluateCluster(recordingId: string, clusterId: ClusterId, windows?: readonly VoiceWindow[]): Promise<MatchDecision | null> {
    const ev = await this.evidence(recordingId, clusterId, windows);
    if (!ev) return null;
    const policy = policyFor(ev.embeddingSpace, this.settings().matchPolicies);
    return decideMatch(ev, await this.candidates(ev.embeddingSpace), policy);
  }

  async identifyRecording(recordingId: string): Promise<MatchDecision[]> {
    const clusters = (await this.repo.listClusters(recordingId)).filter((c) => !c.mergedInto);
    const windows = (await this.repo.listWindows(recordingId)).filter((w) => !isServiceVoiceSpace(w.embeddingSpace));
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

  // Service voice identification (Speechmatics voice ID, irl-subt-3xb.7) ---------------------------------------

  private async serviceProfiles(space: string): Promise<{ personId: string; label: string; identifiers: string[]; latest: string }[]> {
    const out: { personId: string; label: string; identifiers: string[]; latest: string }[] = [];
    for (const p of (await this.repo.listProfiles()).filter((x) => x.embeddingSpace === space && !x.needsReenrollment)) {
      const protos = [...(await this.repo.prototypesForProfile(p.id))].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (!protos.length) continue;
      const identifiers: string[] = [];
      for (const proto of protos) for (const id of await this.openIdentifiers(proto.sealedVector)) if (!identifiers.includes(id)) identifiers.push(id);
      const existing = out.find((o) => o.personId === p.personId);
      if (existing) existing.identifiers.push(...identifiers.filter((i) => !existing.identifiers.includes(i)));
      else out.push({ personId: p.personId, label: serviceVoiceLabel(p.personId), identifiers, latest: protos[0]!.createdAt });
    }
    return out;
  }

  /**
   * Voices to send with a session or job: opaque person labels, never names, within the service's identifier budget.
   * Every person gets their newest identifier first; remaining budget goes to more identifiers, most recent people first.
   */
  async serviceSpeakers(space = SPEECHMATICS_VOICE_SPACE): Promise<ServiceSpeaker[]> {
    const people = (await this.serviceProfiles(space)).sort((a, b) => b.latest.localeCompare(a.latest));
    const chosen = new Map<string, string[]>();
    let budget = MAX_SERVICE_IDENTIFIERS;
    for (let round = 0; budget > 0; round++) {
      let added = false;
      for (const p of people) {
        const id = p.identifiers[round];
        if (!id || budget <= 0) continue;
        chosen.set(p.label, [...(chosen.get(p.label) ?? []), id]);
        budget--;
        added = true;
      }
      if (!added) break;
    }
    return people.filter((p) => chosen.has(p.label)).map((p) => ({ label: p.label, identifiers: chosen.get(p.label)! }));
  }

  /** A service speaker label that names a saved person becomes an accepted match; generic labels (S1…) give null. */
  async serviceDecision(clusterId: ClusterId, providerLabel: string, space = SPEECHMATICS_VOICE_SPACE): Promise<MatchDecision | null> {
    const person = (await this.serviceProfiles(space)).find((p) => p.label === providerLabel);
    if (!person || !(await this.repo.getPerson(person.personId))) return null;
    return { clusterId, best: { personId: person.personId, score: 1 }, second: null, evidenceMs: 0, agreement: 1, status: "accepted", reason: "recognized by Speechmatics", source: "service" };
  }

  /** After a service pass: attribute clusters whose service label is a saved person. */
  async identifyByServiceLabels(recordingId: string, space = SPEECHMATICS_VOICE_SPACE): Promise<MatchDecision[]> {
    const out: MatchDecision[] = [];
    for (const c of (await this.repo.listClusters(recordingId)).filter((x) => !x.mergedInto && x.providerLabel)) {
      const d = await this.serviceDecision(c.clusterId, c.providerLabel!, space);
      if (!d) continue;
      await this.applyDecision(recordingId, d);
      out.push(d);
    }
    return out;
  }

  /**
   * Keeps identifiers a service returned for a recording's speakers (sealed, in the service's voice space) so naming a
   * speaker later can enroll them. Replaces what an earlier pass stored for the same cluster.
   */
  async storeServiceIdentifiers(recordingId: string, speakers: readonly { clusterId: ClusterId; identifiers: string[] }[], space = SPEECHMATICS_VOICE_SPACE): Promise<void> {
    if (!speakers.length) return;
    const turns = await this.repo.listTurns(recordingId);
    const windows: VoiceWindow[] = [];
    for (const s of speakers) {
      const mine = turns.filter((t) => t.clusterId === s.clusterId);
      const startSample = mine.length ? Math.min(...mine.map((t) => t.startSample)) : 0;
      const endSample = mine.length ? Math.max(...mine.map((t) => t.endSample)) : 0;
      windows.push({ id: newId("sid"), recordingId, clusterId: s.clusterId, startSample, endSample, embeddingSpace: space, quality: 1, sealedVector: await this.sealIdentifiers(s.identifiers) });
    }
    const existing = (await this.repo.listWindows(recordingId)).filter((w) => w.embeddingSpace === space && speakers.some((s) => s.clusterId === w.clusterId));
    // voice_windows has no per-row delete: rewrite the recording's windows without the replaced ones.
    if (existing.length) {
      const keep = (await this.repo.listWindows(recordingId)).filter((w) => !existing.includes(w));
      await this.repo.deleteWindows(recordingId);
      await this.repo.putWindows(keep);
    }
    await this.repo.putWindows(windows);
  }

  /** The service rejected saved identifiers (e.g. a model version change): stop sending them until re-enrolled. */
  async markServiceProfilesStale(space = SPEECHMATICS_VOICE_SPACE): Promise<number> {
    const stale = (await this.repo.listProfiles()).filter((p) => p.embeddingSpace === space && !p.needsReenrollment);
    for (const p of stale) await this.repo.putProfile({ ...p, needsReenrollment: true, updatedAt: nowIso() });
    this.invalidate();
    this.changes.emit({});
    return stale.length;
  }

  private sealIdentifiers(identifiers: readonly string[]): Promise<Uint8Array> {
    return this.sealer.seal(new TextEncoder().encode(JSON.stringify(identifiers)));
  }

  private async openIdentifiers(sealed: Uint8Array): Promise<string[]> {
    try {
      const v = JSON.parse(new TextDecoder().decode(await this.sealer.open(sealed))) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
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
    if (!person.fullName) throw new UserError("full-name-required", "A full name is required");
    await this.repo.putPerson(person);
    this.changes.emit({ personId: person.id });
    return person;
  }

  async updatePerson(id: string, patch: { fullName?: string; shortName?: string | null }): Promise<Person> {
    const cur = await this.repo.getPerson(id);
    if (!cur) throw new Error("person not found");
    const next: Person = { ...cur, updatedAt: nowIso() };
    if (patch.fullName !== undefined) {
      if (!patch.fullName.trim()) throw new UserError("full-name-required", "A full name is required");
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
    const service = await this.learnServiceVoice(recordingId, clusterId, personId, operationId);
    const local = await this.learnLocalVoice(recordingId, clusterId, personId, operationId);
    if (!service) return local;
    // No local evidence (a voice-ID recording): keep clips of the speaker's turns, so they can be re-enrolled later.
    const samples = local.samples || (await this.keepTurnClips(recordingId, clusterId, service.profileId, operationId));
    return { prototypes: service.prototypes + local.prototypes, samples };
  }

  /** Enrolls the identifiers the service returned for this cluster, if it returned any. */
  private async learnServiceVoice(recordingId: string, clusterId: ClusterId, personId: string, operationId: string): Promise<{ prototypes: number; profileId: string } | null> {
    const clusters = new Map((await this.repo.listClusters(recordingId)).map((c) => [c.clusterId, c]));
    const rows = (await this.repo.listWindows(recordingId)).filter((w) => isServiceVoiceSpace(w.embeddingSpace) && resolveCluster(clusters, w.clusterId) === clusterId);
    if (!rows.length) return null;
    const bySpace = new Map<string, VoiceWindow[]>();
    for (const w of rows) bySpace.set(w.embeddingSpace, [...(bySpace.get(w.embeddingSpace) ?? []), w]);
    let prototypes = 0;
    let profileId = "";
    for (const [space, windows] of bySpace) {
      const identifiers = [...new Set((await Promise.all(windows.map((w) => this.openIdentifiers(w.sealedVector)))).flat())].slice(0, IDENTIFIERS_PER_PROTOTYPE);
      if (!identifiers.length) continue;
      const now = nowIso();
      const profile = (await this.repo.profilesForPerson(personId)).find((p) => p.embeddingSpace === space) ?? { id: newId("profile"), personId, embeddingSpace: space, needsReenrollment: false, createdAt: now, updatedAt: now };
      await this.repo.putProfile({ ...profile, needsReenrollment: false, updatedAt: now });
      const turns = (await this.repo.listTurns(recordingId)).filter((t) => resolveCluster(clusters, t.clusterId) === clusterId);
      await this.repo.putPrototype({
        id: newId("proto"), profileId: profile.id, sealedVector: await this.sealIdentifiers(identifiers), quality: 1, evidenceMs: turns.reduce((n, t) => n + rangeDurationMs(t), 0),
        sourceRecordingId: recordingId, operationId, createdAt: now,
      });
      await this.prunePrototypes(profile.id);
      prototypes++;
      profileId = profile.id;
    }
    this.invalidate();
    return prototypes ? { prototypes, profileId } : null;
  }

  private async keepTurnClips(recordingId: string, clusterId: ClusterId, profileId: string, operationId: string): Promise<number> {
    const clusters = new Map((await this.repo.listClusters(recordingId)).map((c) => [c.clusterId, c]));
    const turns = (await this.repo.listTurns(recordingId)).filter((t) => t.final && resolveCluster(clusters, t.clusterId) === clusterId);
    const others = (await this.repo.listTurns(recordingId)).filter((t) => resolveCluster(clusters, t.clusterId) !== clusterId);
    // Longest turns that nobody else talks over, cut to 4 s pieces.
    const ranges = turns
      .filter((t) => !others.some((o) => overlap(o, t) > 0))
      .sort((a, b) => b.endSample - b.startSample - (a.endSample - a.startSample))
      .slice(0, 4)
      .map((t) => ({ startSample: t.startSample, endSample: Math.min(t.endSample, t.startSample + 4 * SAMPLE_RATE) }));
    return this.saveSamples(profileId, recordingId, ranges, operationId);
  }

  private async learnLocalVoice(recordingId: string, clusterId: ClusterId, personId: string, operationId: string): Promise<{ prototypes: number; samples: number; reason?: string }> {
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
    const samples = await this.saveSamples(profile.id, recordingId, clean.slice(0, 4).map((w) => w.row), operationId);
    this.invalidate();
    this.changes.emit({ recordingId, personId });
    return { prototypes: 1, samples };
  }

  private async saveSamples(profileId: string, recordingId: string, ranges: readonly TimeRange[], operationId: string): Promise<number> {
    let samples = 0;
    let clipBudget = CLIP_MAX_MS;
    for (const r of ranges) {
      const sample: VoiceSample = { id: newId("sample"), profileId, recordingId, startSample: r.startSample, endSample: r.endSample, clipPath: null, consent: true, operationId, createdAt: nowIso() };
      if (this.settings().keepVoiceClips && clipBudget > 0) {
        try {
          const pcm = await this.audio.readRange(recordingId, r);
          if (pcm.some((v) => v !== 0)) {
            const path = `voice/${profileId}/${sample.id}.pcm`;
            await this.blobs.write(path, await this.sealer.seal(float32ToPcm(pcm)));
            sample.clipPath = path;
            clipBudget -= rangeDurationMs(r);
          }
        } catch {
          /* audio no longer available: keep the sample without a clip */
        }
      }
      await this.repo.putSample(sample);
      samples++;
    }
    return samples;
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
    if (isServiceVoiceSpace(newSpace)) return this.enrollWithService(newSpace);
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

  /**
   * Voice ID from kept clips (plan.md §6.1 mirror for a service space): each person's clips go to the service as one
   * short enrollment job whose identifiers become their profile; people without clips (or when enrollment fails) need
   * naming again.
   */
  private async enrollWithService(space: string): Promise<{ reembedded: number; needsReenrollment: number }> {
    const byPerson = new Map<string, VoiceProfile[]>();
    for (const p of await this.repo.listProfiles()) byPerson.set(p.personId, [...(byPerson.get(p.personId) ?? []), p]);
    let enrolled = 0;
    let needs = 0;
    for (const [personId, profiles] of byPerson) {
      if (profiles.some((p) => p.embeddingSpace === space && !p.needsReenrollment)) continue;
      const now = nowIso();
      const target: VoiceProfile = profiles.find((p) => p.embeddingSpace === space) ?? { id: newId("profile"), personId, embeddingSpace: space, needsReenrollment: true, createdAt: now, updatedAt: now };
      const clips = (await Promise.all(profiles.map((p) => this.repo.samplesForProfile(p.id)))).flat().filter((s) => s.clipPath);
      const audio: Uint8Array[] = [];
      for (const s of clips) {
        const sealed = await this.blobs.read(s.clipPath!);
        if (!sealed) continue;
        try {
          audio.push(await this.sealer.open(sealed));
        } catch {
          /* unreadable clip */
        }
      }
      const identifiers = audio.length && this.serviceEnroll ? await this.serviceEnroll(clipsWav(audio), this.settings().language).catch(() => null) : null;
      if (!identifiers?.length) {
        await this.repo.putProfile({ ...target, needsReenrollment: true, updatedAt: now });
        needs++;
        continue;
      }
      // Identifiers the profile had are stale (that's why it needed enrolling); they must not be sent again.
      for (const old of await this.repo.prototypesForProfile(target.id)) await this.repo.deletePrototype(old.id);
      await this.repo.putProfile({ ...target, needsReenrollment: false, updatedAt: now });
      await this.repo.putPrototype({
        id: newId("proto"), profileId: target.id, sealedVector: await this.sealIdentifiers(identifiers.slice(0, IDENTIFIERS_PER_PROTOTYPE)), quality: 1,
        evidenceMs: audio.reduce((n, a) => n + (a.byteLength / 2 / SAMPLE_RATE) * 1000, 0), sourceRecordingId: clips[0]!.recordingId, operationId: newId("reenroll"), createdAt: now,
      });
      enrolled++;
    }
    this.invalidate();
    this.changes.emit({});
    return { reembedded: enrolled, needsReenrollment: needs };
  }
}

/** Joins voice clips into one WAV with short silences between them, for enrolling with a service. */
function clipsWav(clips: readonly Uint8Array[]): Uint8Array {
  const gap = new Uint8Array(Math.round(0.3 * SAMPLE_RATE) * 2);
  const parts = clips.flatMap((c, i) => (i ? [gap, c] : [c]));
  const bytes = parts.reduce((n, p) => n + p.byteLength, 0);
  return concatBytes([wavHeader(bytes), ...parts]);
}

function nextRevision(rows: readonly SpeakerAttribution[]): number {
  return rows.reduce((m, r) => Math.max(m, r.revision), 0) + 1;
}

function stripCandidate(c: SpeakerCluster): SpeakerCluster {
  const { candidatePersonId: _a, candidateScore: _b, ...rest } = c;
  return rest;
}
