import {
  SERVICE_NAMES,
  serviceOption,
  type CloudService,
  type DataFlow,
  type DegradedReason,
  type KeyTestResult,
  type LiveProblem,
  type MatchDecision,
  type MatchFailure,
  type ModelRole,
  type OptionBlocker,
  type Problem,
  type RoleLock,
  type RoleOption,
  type ServiceOption,
  type StageNote,
  type UiLocale,
} from "@irl/domain";
import type { Messages } from "./catalogs/en";
import { formatters } from "./format";

/**
 * Codes from the domain and pipeline (irl-subt-0n7.4) as sentences in one UI language. The catalog holds the words;
 * this holds the grammar of which words a code needs.
 */
export function describer(locale: UiLocale, m: Messages) {
  const f = formatters(locale, m);
  const service = (s: CloudService) => (s === "summary-endpoint" ? m.services.summaryEndpoint : SERVICE_NAMES[s]);
  const or = (items: readonly string[]) => new Intl.ListFormat(locale, { type: "disjunction" }).format(items);

  const problem = (p: Problem): string => {
    const s = p.service ? service(p.service) : "";
    switch (p.code) {
      case "glasses-unavailable":
        return m.errors.glassesUnavailable;
      case "glasses-page":
        return m.errors.glassesPage;
      case "glasses-audio":
        return m.errors.glassesAudio;
      case "key-missing":
        return m.errors.keyMissing(s);
      case "key-rejected":
        return m.errors.keyRejected(s);
      case "service-unreachable":
        return m.errors.unreachable(s);
      case "service-timeout":
        return m.errors.timeout(s);
      case "recording-in-progress":
        return m.errors.recordingInProgress;
      case "audio-setting-locked":
        return m.errors.audioSettingLocked;
      case "full-name-required":
        return m.errors.fullNameRequired;
      case "cancelled":
        return m.errors.cancelled;
      case undefined:
        return p.detail;
    }
  };

  return {
    service,

    blocker(b: OptionBlocker): string {
      switch (b.code) {
        case "role":
          return m.selection.role;
        case "language":
          return m.selection.language(b.language === "auto" ? m.languages.auto : f.language(b.language));
        case "key":
          return m.selection.key(service(b.service));
        case "summary-endpoint":
          return m.selection.summaryEndpoint;
        case "needs-service":
          return m.selection.needsService(service(b.service), or(b.roles.map((r) => m.selection.roleInSentence[r])));
        case "missing":
          return m.selection.missing;
        case "other-language":
          return m.selection.otherLanguage;
        case "device":
          return m.selection.device(b.detail);
      }
    },

    lock(lock: RoleLock, role: ModelRole): { label: string; reason: string } {
      const s = service(lock.service);
      const reason = role === "vad" ? (lock.kind === "live-stream" ? m.selection.lockVadStream(s) : m.selection.lockVadBatch(s)) : role === "stt-final" ? m.selection.lockFinal(s) : m.selection.lockOther(s);
      return { label: m.selection.providedBy(s), reason };
    },

    /** A cloud option's or special's name; local catalog models keep their own (proper-noun) names. */
    optionName(o: Pick<RoleOption, "id" | "label" | "group">, role: ModelRole): string {
      if (o.group === "special") return o.id === "same-as-live" ? m.selection.sameAsLive : role === "stt-live" ? m.selection.liveOff : m.selection.off;
      const cloud = serviceOption(o.id);
      return cloud ? this.serviceOptionName(cloud) : o.label;
    },

    serviceOptionName(o: ServiceOption): string {
      const s = service(o.service);
      const showsModel = o.displayName.includes(`(${o.model}`);
      switch (o.kind) {
        case "live-stream":
          return showsModel ? m.selection.withModel(s, o.model) : s;
        case "batch-final":
          return showsModel ? m.selection.afterStopModel(s, o.model) : m.selection.afterStop(s);
        case "voice-id":
          return m.selection.voiceId;
        case "summary":
          return m.selection.cloudSummary;
      }
    },

    serviceOptionNote(o: ServiceOption): string | null {
      const s = service(o.service);
      switch (o.kind) {
        case "live-stream":
          return m.selection.liveNote(s);
        case "batch-final":
          return o.service === "soniox" ? m.selection.batchNoteDeleted(s) : m.selection.batchNote(s);
        case "voice-id":
          return m.selection.voiceIdNote;
        case "summary":
          return null;
      }
    },

    dataFlow(flow: DataFlow): string {
      const parts: string[] = [];
      if (flow.live && flow.final && flow.live === flow.final) parts.push(m.dataFlow.both(service(flow.live)));
      else {
        if (flow.live) parts.push(m.dataFlow.live(service(flow.live)));
        if (flow.final) parts.push(m.dataFlow.final(service(flow.final)));
      }
      if (flow.voiceId) parts.push(m.dataFlow.voiceId(service(flow.voiceId)));
      else if (parts.length) parts.push(m.dataFlow.voicesLocal);
      if (flow.summary) parts.push(m.dataFlow.summary);
      return parts.length ? m.dataFlow.sentence(parts) : m.dataFlow.local;
    },

    recordingServices(x: { services: readonly CloudService[]; local: boolean }): string {
      if (!x.services.length) return m.services.onDevice;
      const names = x.services.map(service).join(" + ");
      return x.local ? m.services.withOnDevice(names) : names;
    },

    degraded(r: DegradedReason): string {
      switch (r.code) {
        case "slowed":
          return m.degraded.slowed;
        case "saving-later":
          return r.detail ? m.degraded.savingLaterDetail(r.detail) : m.degraded.savingLater;
        case "captions-paused":
          return m.degraded.captionsPaused;
        case "not-downloaded":
          return m.degraded.notDownloaded(m.degraded.parts[r.part]);
        case "unavailable":
          return m.degraded.unavailable(m.degraded.parts[r.part]);
        case "vad-failed":
          return m.degraded.vadFailed;
        case "restarting":
          return m.degraded.restarting(r.detail);
        case "reconnecting":
          return m.degraded.reconnecting(service(r.service));
      }
    },

    problem,

    /** Anything thrown: a UserError in the UI language, else its message. */
    error(e: unknown): string {
      if (e && typeof e === "object" && "code" in e && "message" in e && (e as { name?: string }).name === "UserError") {
        const u = e as { code: Problem["code"]; message: string; service?: CloudService };
        return problem({ detail: u.message, code: u.code, ...(u.service ? { service: u.service } : {}) });
      }
      return e instanceof Error ? e.message : String(e);
    },

    liveProblem(p: LiveProblem): string {
      const text = problem(p);
      if (p.during === "start") return m.errors.startFailed(text);
      return p.code ? text : p.during === "saving" ? m.errors.saving(text) : m.errors.recording(text);
    },

    /** A failed stage's stored error. */
    stageError(st: { error?: string; errorCode?: Problem["code"]; errorService?: CloudService }): string | null {
      if (!st.error) return null;
      return problem({ detail: st.error, ...(st.errorCode ? { code: st.errorCode } : {}), ...(st.errorService ? { service: st.errorService } : {}) });
    },

    stageNote(n: StageNote): string {
      const x = m.stages;
      switch (n.code) {
        case "detecting-speech":
          return x.detectingSpeech;
        case "embedding-voices":
          return x.embeddingVoices;
        case "uploading":
          return x.uploading(service(n.service));
        case "waiting":
          return x.waiting(service(n.service));
        case "fetching":
          return x.fetching;
        case "summarizing":
          return x.summarizing(n.parts);
        case "summary-part":
          return x.summaryPart(n.part, n.parts);
        case "sending-transcript":
          return x.sendingTranscript;
        case "validating":
          return x.validating;
        case "final-tokens":
          return x.finalTokens(service(n.service));
        case "no-model":
          return x.noModel;
        case "same-as-live":
          return x.sameAsLive;
        case "audio-unavailable":
          return x.audioUnavailable;
        case "words": {
          let text = x.words(n.words);
          if (n.speakers !== undefined) text = x.withSpeakers(text, n.speakers);
          if (n.service) text = x.fromService(text, service(n.service));
          return n.language ? x.withLanguage(text, f.language(n.language)) : text;
        }
        case "service-speakers":
          return x.serviceSpeakers(service(n.service));
        case "no-speech":
          return x.noSpeech;
        case "no-voice-windows":
          return x.noVoiceWindows;
        case "speakers":
          return x.speakers(n.speakers, n.windows);
        case "no-local-evidence":
          return x.noLocalEvidence;
        case "labels-linked":
          return x.labelsLinked(n.windows, n.merges);
        case "recognized":
          return n.service ? x.recognizedBy(n.recognized, service(n.service)) : x.recognized(n.recognized, n.total ?? n.recognized);
        case "summary-off":
          return x.summaryOff;
        case "empty-transcript":
          return x.emptyTranscript;
        case "no-audio":
          return x.noAudio;
        case "audio-removed":
          return n.ephemeral ? x.ephemeralRemoved : x.audioDeleted;
        case "keeping-pcm":
          return x.keepingPcm;
        case "compressed":
          return x.compressed(f.number(n.mib, 1));
      }
    },

    keyTest(r: KeyTestResult, s: CloudService): string {
      const name = service(s);
      switch (r.code) {
        case "ok":
          return m.keyTest.ok;
        case "rejected":
          return s === "speechmatics" ? m.keyTest.rejectedRegion(name) : m.keyTest.rejected(name);
        case "http":
          return m.keyTest.http(name, r.status ?? 0);
        case "unreachable":
          return m.keyTest.unreachable(name);
      }
    },

    matchFailure(x: MatchFailure): string {
      switch (x.criterion) {
        case "evidence":
          return m.match.evidence(f.seconds(x.value / 1000, 1), f.seconds(x.threshold / 1000));
        case "score":
          return m.match.score(f.number(x.value, 3), f.number(x.threshold, 2));
        case "margin":
          return m.match.margin(f.number(x.value, 3), f.number(x.threshold, 2));
        case "agreement":
          return m.match.agreement(f.percent(x.value), f.percent(x.threshold));
      }
    },

    matchReason(d: MatchDecision): string {
      if (d.rejection) return d.rejection === "no-clean-windows" ? m.match.noCleanWindows : m.match.noComparableProfiles;
      if (d.failures?.length) return d.failures.map((x) => this.matchFailure(x)).join(locale === "ja" ? "、" : "; ");
      return d.status === "accepted" ? m.match.allMet : d.reason;
    },
  };
}

export type Describer = ReturnType<typeof describer>;
