import { createSignal, For, onSettled, Show } from "solid-js";
import { describe, fmt, locale, t } from "@irl/i18n";
import { formatClock, recordingLocks, recordingServices, SAMPLE_RATE, selectionLocks, serviceOption, type AnchoredText, type ClusterId, type ProcessingStage, type StageNote, type TranscriptSegment } from "@irl/domain";
import { ALL_STAGES, deleteRecording, deleteRecordingAudio, exportRecording, type PostStage } from "@irl/pipeline";
import { catalogEntry } from "@irl/provider-local";
import { app, bumpData, Button, download, duration, go, Sheet, SpanText, speakerColor, SpeakerName, toast, useData, when } from "./lib";
import { loadRecording, stateLabel, type RecordingModel } from "./model";
import { SpeakerSheet } from "./SpeakerSheet";

export function RecordingView(props: { id: string; focus?: string }) {
  const data = useData(() => props.id, loadRecording);
  const [tab, setTab] = createSignal<"summary" | "transcript">("summary");
  const [sheet, setSheet] = createSignal<ClusterId | null>(null);
  const [highlight, setHighlight] = createSignal<Set<string>>(new Set());
  const [query, setQuery] = createSignal("");
  const [audioUrl, setAudioUrl] = createSignal<string | null>(null);
  const [progress, setProgress] = createSignal<{ stage: string; progress?: number; note?: StageNote } | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  let player: HTMLAudioElement | undefined;

  onSettled(() => {
    const off = app().post.events.on((e) => {
      if (e.recordingId !== props.id) return;
      setProgress(e.stage === "done" ? null : { stage: e.stage, progress: e.progress, ...(e.note ? { note: e.note } : {}) });
    });
    return () => {
      off();
      const url = audioUrl();
      if (url) URL.revokeObjectURL(url);
    };
  });

  const seek = (sample: number) => {
    if (!player) return;
    player.currentTime = sample / SAMPLE_RATE;
    void player.play().catch(() => undefined);
  };

  const showSources = (ids: string[]) => {
    setHighlight(new Set(ids));
    setTab("transcript");
    setTimeout(() => document.getElementById(`seg-${ids[0]}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };

  return (
    <Show when={data.value()} fallback={<p class="muted">{data.error() ?? (data.loading() ? t().common.loading : t().recording.deleted)}</p>}>
      {(m) => (
        <>
          <Header m={m()} />
          <Processing m={m()} progress={progress()} />
          <Show when={m().hasAudio}>
            <div class="stack">
              <Show
                when={audioUrl()}
                fallback={
                  <Button
                    label={t().recording.loadAudio}
                    busyLabel={t().recording.preparingAudio}
                    onClick={async () => setAudioUrl(URL.createObjectURL(await app().audio.wav(props.id)))}
                  />
                }
              >
                <audio controls src={audioUrl()!} ref={(el) => (player = el)} style={{ width: "100%" }} />
              </Show>
              <Show when={m().recording.markers.length > 0}>
                <div class="row small">
                  <span class="muted">{t().recording.markers}</span>
                  <For each={m().recording.markers}>
                    {(mk) => (
                      <button type="button" class="btn quiet num" onClick={() => seek(mk.sample)} disabled={!audioUrl()}>
                        {formatClock(mk.sample)}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>

          <div class="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab() === "summary" ? "true" : "false"} onClick={() => setTab("summary")}>
              {t().recording.summaryTab}
            </button>
            <button type="button" role="tab" aria-selected={tab() === "transcript" ? "true" : "false"} onClick={() => setTab("transcript")}>
              {t().recording.transcriptTab}
            </button>
          </div>

          <Show when={tab() === "summary"}>
            <SummarySection m={m()} onSpeaker={setSheet} onSources={showSources} />
          </Show>
          <Show when={tab() === "transcript"}>
            <div class="stack">
              <input type="search" placeholder={t().recording.search} value={query()} onInput={(e) => setQuery(e.currentTarget.value)} aria-label={t().recording.search} />
              <Show when={m().segments.length === 0}>
                <p class="muted">{m().recording.state === "ready" ? t().recording.noSpeech : t().recording.transcriptLater}</p>
              </Show>
              <div>
                <For each={m().segments.filter((s) => !query() || s.text.toLowerCase().includes(query().toLowerCase()) || (s.clusterId && m().label(s.clusterId).text.toLowerCase().includes(query().toLowerCase())))}>
                  {(seg) => <Segment m={m()} seg={seg} highlight={highlight().has(seg.id)} query={query()} onSpeaker={setSheet} onSeek={audioUrl() ? seek : undefined} />}
                </For>
              </div>
            </div>
          </Show>

          <div class="panel">
            <h2>{t().recording.exportTitle}</h2>
            <div class="row">
              <Button
                label={t().recording.exportText}
                onClick={async () => {
                  const { markdown } = await exportRecording(app().storage.repo, props.id, locale());
                  download(`${m().recording.title ?? t().recording.fileName}.md`, new Blob([markdown], { type: "text/markdown" }));
                }}
              />
              <Button
                label={t().recording.exportJson}
                onClick={async () => {
                  const { json } = await exportRecording(app().storage.repo, props.id, locale());
                  download(`${m().recording.title ?? t().recording.fileName}.json`, new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }));
                }}
              />
            </div>
            <p class="small muted">{t().recording.exportNote}</p>
            <div class="row">
              <Show when={m().hasAudio}>
                <Button
                  label={t().recording.deleteAudio}
                  kind="danger"
                  onClick={async () => {
                    if (!confirm(t().recording.deleteAudioConfirm)) return;
                    await deleteRecordingAudio(app().storage.repo, app().storage.blobs, props.id);
                    setAudioUrl(null);
                    bumpData();
                    toast(t().recording.audioDeleted);
                  }}
                />
              </Show>
              <Button label={t().recording.deleteConversation} kind="danger" onClick={() => setDeleting(true)} />
            </div>
          </div>

          <Show when={sheet()}>
            <SpeakerSheet recordingId={props.id} clusterId={sheet()!} onClose={() => setSheet(null)} />
          </Show>
          <Show when={deleting()}>
            <DeleteSheet id={props.id} onClose={() => setDeleting(false)} />
          </Show>
        </>
      )}
    </Show>
  );
}

function Header(props: { m: RecordingModel }) {
  const r = () => props.m.recording;
  const [editing, setEditing] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const badge = () => stateLabel(r());
  return (
    <div class="stack" style={{ gap: "6px" }}>
      <a href="#/" class="small">
        {t().nav.conversations}
      </a>
      <Show
        when={editing()}
        fallback={
          <div class="spread">
            <h1>{r().title ?? t().history.untitled}</h1>
            <button
              type="button"
              class="btn quiet"
              onClick={() => {
                setTitle(r().title ?? "");
                setEditing(true);
              }}
            >
              {t().recording.rename}
            </button>
          </div>
        }
      >
        <div class="row">
          <input type="text" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} aria-label={t().recording.titleLabel} style={{ flex: "1" }} />
          <Button
            label={t().common.save}
            kind="primary"
            onClick={async () => {
              await app().storage.repo.updateRecording(r().id, { title: title().trim() || null });
              setEditing(false);
              bumpData();
            }}
          />
        </div>
      </Show>
      <p class="muted small num">
        {when(r().startedAt ?? r().createdAt)} · {duration(r().totalSamples)} · {describe().recordingServices(recordingServices(r()))} · {r().language} ·{" "}
        {r().audioRetention === "persisted" ? t().recording.audioSaved : r().audioRetention === "ephemeral" ? t().recording.audioNotKept : t().recording.audioRemoved}{" "}
        <span class={["badge", { busy: badge().kind === "busy", bad: badge().kind === "bad" }]}>{badge().text}</span>
      </p>
      <Show when={r().error}>
        <p class="warn small">{r().error}</p>
      </Show>
    </div>
  );
}

function Processing(props: { m: RecordingModel; progress: { stage: string; progress?: number; note?: StageNote } | null }) {
  const r = () => props.m.recording;
  const settings = () => app().settings.get();
  const failed = () => (Object.entries(r().processing) as [ProcessingStage, { status: string }][]).filter(([s, v]) => s !== "liveStt" && v.status === "failed");
  const outdated = () => {
    const out: { stage: PostStage; label: string; patch: Partial<typeof settings.prototype> }[] = [];
    const cur = settings().models;
    // A final transcript some other option provided (a live stream's final tokens) can't be redone on its own.
    if (!recordingLocks(r())["stt-final"] && cur.sttFinal !== r().models.sttFinal) out.push({ stage: "finalStt", label: t().recording.reTranscribe(serviceOption(cur.sttFinal) ? describe().serviceOptionName(serviceOption(cur.sttFinal)!) : (catalogEntry(cur.sttFinal)?.displayName ?? cur.sttFinal)), patch: {} });
    if (cur.summary !== r().models.summary && cur.summary !== "off") out.push({ stage: "summary", label: t().recording.reSummarize(serviceOption(cur.summary) ? t().services.summaryEndpoint : (catalogEntry(cur.summary)?.displayName ?? cur.summary)), patch: {} });
    return out;
  };
  const busy = () => r().state === "finalizing" || r().state === "captured" || app().post.currentRecordingId === r().id;

  const reprocess = async (stages: PostStage[]) => {
    const cur = settings().models;
    const models = { ...r().models };
    if (stages.includes("finalStt")) models.sttFinal = cur.sttFinal;
    if (stages.includes("summary")) models.summary = cur.summary;
    await app().storage.repo.updateRecording(r().id, { models, selection: { locks: selectionLocks(models) } });
    // A new transcript invalidates speakers and summary downstream.
    const expanded: PostStage[] = stages.includes("finalStt") ? ["finalStt", "diarization", "identity", "summary"] : stages;
    app().post.enqueue(r().id, expanded);
    bumpData();
    toast(t().recording.processingAgain);
  };

  return (
    <Show when={busy() || failed().length > 0 || outdated().length > 0 || r().state === "interrupted"}>
      <div class="panel">
        <h2>{busy() ? t().recording.processing : t().recording.processingResults}</h2>
        <Show when={busy() && app().controller.activeRecordingId}>
          <p class="small muted">{t().recording.waitsForRecording}</p>
        </Show>
        <For each={ALL_STAGES}>
          {(stage) => {
            const st = () => r().processing[stage];
            return (
              <div class="stage">
                <span>{t().recording.stages[stage]}</span>
                <span class={["small", { error: st().status === "failed", muted: st().status !== "failed" }]}>
                  {st().status === "running" && props.progress?.stage === stage && props.progress.progress !== undefined ? fmt().percent(props.progress.progress) : t().recording.stageStatus[st().status]}
                </span>
                <Show when={st().status === "failed" ? describe().stageError(st()) : st().note ? describe().stageNote(st().note!) : null}>
                  {(text) => (
                    <span class="small muted" style={{ "grid-column": "1 / -1" }}>
                      {text()}
                    </span>
                  )}
                </Show>
              </div>
            );
          }}
        </For>
        <Show when={props.progress?.note}>{(n) => <p class="small muted">{describe().stageNote(n())}</p>}</Show>
        <div class="row">
          <Show when={r().state === "interrupted"}>
            <Button label={t().app.finishProcessing} kind="primary" onClick={() => reprocess([...ALL_STAGES])} />
          </Show>
          <Show when={!busy() && failed().length > 0}>
            <Button label={t().recording.retryFailed} kind="primary" onClick={() => reprocess(failed().map(([s]) => s as PostStage))} />
          </Show>
          <Show when={!busy()}>
            <For each={outdated()}>{(o) => <Button label={o.label} onClick={() => reprocess([o.stage])} />}</For>
          </Show>
          <Show when={busy()}>
            <Button label={t().common.cancel} kind="quiet" onClick={() => app().post.cancelCurrent()} />
          </Show>
        </div>
      </div>
    </Show>
  );
}

function SummarySection(props: { m: RecordingModel; onSpeaker: (id: ClusterId) => void; onSources: (ids: string[]) => void }) {
  const s = () => props.m.summary;
  const span = (text: string) => <SpanText text={text} label={props.m.label} ordinal={props.m.ordinal} onOpen={props.onSpeaker} />;
  const Items = (p: { title: string; items: readonly AnchoredText[] }) => (
    <Show when={p.items.length > 0}>
      <section class="stack" style={{ gap: "6px" }}>
        <h3>{p.title}</h3>
        <ul style={{ margin: 0, "padding-left": "1.2em" }}>
          <For each={p.items}>
            {(item) => (
              <li>
                {span(item.text)}{" "}
                <Show when={item.sourceSegmentIds.length > 0}>
                  <button type="button" class="btn quiet small" onClick={() => props.onSources(item.sourceSegmentIds)}>
                    {t().recording.showSource}
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
  return (
    <Show
      when={s()?.summary}
      fallback={
        <p class="muted">
          {s()?.status === "failed" ? t().recording.summaryFailed(s()?.error ?? "") : s()?.status === "off" ? t().recording.summaryOff : s()?.status === "running" ? t().recording.summaryWriting : t().recording.summaryLater}
        </p>
      }
    >
      {(sum) => (
        <div class="stack">
          <p>{span(sum().overview)}</p>
          <Items title={t().summary.keyPoints} items={sum().keyPoints} />
          <Items title={t().summary.decisions} items={sum().decisions} />
          <Show when={sum().actionItems.length > 0}>
            <section class="stack" style={{ gap: "6px" }}>
              <h3>{t().summary.actionItems}</h3>
              <ul style={{ margin: 0, "padding-left": "1.2em" }}>
                <For each={sum().actionItems}>
                  {(a) => (
                    <li>
                      {span(a.text)}
                      <Show when={a.ownerClusterId}>
                        {(owner) => (
                          <>
                            {" "}
                            (<SpeakerName label={props.m.label(owner())} ordinal={props.m.ordinal(owner())} onOpen={props.onSpeaker} />)
                          </>
                        )}
                      </Show>
                      <Show when={a.dueText}>{(due) => ` ${t().summary.due(due())}`}</Show>{" "}
                      <Show when={a.sourceSegmentIds.length > 0}>
                        <button type="button" class="btn quiet small" onClick={() => props.onSources(a.sourceSegmentIds)}>
                          {t().recording.showSource}
                        </button>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
          <Items title={t().summary.openQuestions} items={sum().openQuestions} />
          <p class="small muted">{sum().providerId === "cloud" ? t().recording.writtenByCloud(when(sum().generatedAt)) : t().recording.writtenOnPhone(when(sum().generatedAt))}</p>
        </div>
      )}
    </Show>
  );
}

function Segment(props: { m: RecordingModel; seg: TranscriptSegment; highlight: boolean; query: string; onSpeaker: (id: ClusterId) => void; onSeek?: (sample: number) => void }) {
  const ordinal = () => (props.seg.clusterId ? props.m.ordinal(props.seg.clusterId) : undefined);
  const text = () => {
    const q = props.query.trim();
    if (!q) return [props.seg.text];
    const idx = props.seg.text.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return [props.seg.text];
    return [props.seg.text.slice(0, idx), <mark>{props.seg.text.slice(idx, idx + q.length)}</mark>, props.seg.text.slice(idx + q.length)];
  };
  return (
    <div id={`seg-${props.seg.id}`} class={["turn", { highlight: props.highlight, provisional: !props.seg.final }]} style={{ "--spk-color": props.seg.clusterId ? speakerColor(ordinal()) : "var(--line)" }}>
      <div>
        <div class="meta">
          <Show when={props.seg.clusterId} fallback={<span class="muted small">{t().recording.unknownSpeaker}</span>}>
            {(cid) => <SpeakerName label={props.m.label(cid())} ordinal={ordinal()} onOpen={props.onSpeaker} />}
          </Show>
          <Show when={props.onSeek} fallback={<span class="small muted num">{formatClock(props.seg.startSample)}</span>}>
            <button type="button" class="btn quiet small num" style={{ "min-height": "0", padding: "0" }} onClick={() => props.onSeek!(props.seg.startSample)}>
              {formatClock(props.seg.startSample)}
            </button>
          </Show>
        </div>
        <p>{text()}</p>
      </div>
    </div>
  );
}

function DeleteSheet(props: { id: string; onClose: () => void }) {
  const [removeSamples, setRemoveSamples] = createSignal(false);
  return (
    <Sheet title={t().recording.deleteConversation} onClose={props.onClose}>
      <p>{t().recording.deleteBody}</p>
      <label class="check">
        <input type="checkbox" checked={removeSamples()} onChange={(e) => setRemoveSamples(e.currentTarget.checked)} />
        <span>{t().recording.alsoRemoveSamples}</span>
      </label>
      <Button
        label={t().recording.deleteConversation}
        kind="danger"
        onClick={async () => {
          const r = await deleteRecording(app().storage.repo, app().storage.blobs, props.id, { removeVoiceSamples: removeSamples() });
          app().identity.changes.emit({});
          props.onClose();
          go("#/");
          bumpData();
          toast(r.removedPrototypes || r.removedSamples ? t().recording.deletedWithSamples(r.removedSamples) : t().recording.conversationDeleted);
        }}
      />
    </Sheet>
  );
}
