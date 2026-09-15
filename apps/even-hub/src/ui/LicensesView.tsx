import { createSignal, For, Show } from "solid-js";
import type { ModelCatalogEntry } from "@irl/domain";
import { t } from "@irl/i18n";
import { CATALOG } from "@irl/provider-local";
import type { LicenseNotice, LicensesFile } from "../../licenses/types";
import { useData } from "./lib";

/** Required wording from the Gemma Terms of Use; not translated. */
const GEMMA_NOTICE = "Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms.";

const LICENSE_PAGES: Record<string, string> = {
  "Gemma Terms of Use": "https://ai.google.dev/gemma/terms",
  "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
  "Moonshine Community License (non-commercial)": "https://github.com/moonshine-ai/moonshine/blob/main/LICENSE",
};

function sourcePage(e: ModelCatalogEntry): string {
  const src = e.manifest.source;
  if (src.type === "hf") return `https://huggingface.co/${src.repo}`;
  return e.manifest.adapter === "moonshine-wasm" ? "https://github.com/moonshine-ai/moonshine" : src.baseUrl;
}

/** Third-party licenses: software in the build (licenses.json, written by licenses/plugin.ts) and downloadable models. */
export function LicensesView() {
  const file = useData(
    () => 0,
    async () => {
      const res = await fetch(`${import.meta.env.BASE_URL}licenses.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as LicensesFile;
    },
  );
  const models = CATALOG.filter((e) => e.availability.status === "available");

  return (
    <>
      <a href="#/settings" class="small">
        {t().nav.settings}
      </a>
      <h1>{t().licenses.title}</h1>
      <p class="muted">{t().licenses.intro}</p>
      <Show when={file.error()}>{(err) => <p class="error">{t().licenses.loadFailed(err())}</p>}</Show>
      <Show when={file.value()}>
        {(f) => (
          <>
            <section class="panel">
              <h2>{t().licenses.software}</h2>
              <div class="stack" style={{ gap: "8px" }}>
                <For each={f().packages}>{(n) => <Notice notice={n} />}</For>
              </div>
            </section>
            <section class="panel">
              <h2>{t().licenses.components}</h2>
              <p class="small muted">{t().licenses.componentsHint}</p>
              <div class="stack" style={{ gap: "8px" }}>
                <For each={f().components}>{(n) => <Notice notice={n} />}</For>
              </div>
            </section>
          </>
        )}
      </Show>
      <section class="panel">
        <h2>{t().licenses.models}</h2>
        <p class="small muted">{t().licenses.modelsHint}</p>
        <ul class="licenses-models">
          <For each={models}>
            {(e) => (
              <li>
                <strong>{e.displayName}</strong>{" "}
                <Show when={LICENSE_PAGES[e.license]} fallback={<span class="muted">{e.license}</span>}>
                  {(page) => (
                    <a href={page()} target="_blank" rel="noreferrer">
                      {e.license}
                    </a>
                  )}
                </Show>
                <span class="small" style={{ display: "block" }}>
                  <a href={sourcePage(e)} target="_blank" rel="noreferrer">
                    {sourcePage(e)}
                  </a>
                </span>
              </li>
            )}
          </For>
        </ul>
        <Show when={models.some((e) => e.license === "Gemma Terms of Use")}>
          <p class="small">{GEMMA_NOTICE}</p>
        </Show>
      </section>
    </>
  );
}

/** One license, collapsed; the text renders only once opened (some are hundreds of kilobytes). */
function Notice(props: { notice: LicenseNotice }) {
  const [open, setOpen] = createSignal(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <strong>{props.notice.name}</strong> <span class="muted">{props.notice.version}</span> <span class="small muted">({props.notice.license})</span>
      </summary>
      <Show when={open()}>
        <div class="stack" style={{ gap: "4px", "margin-top": "8px" }}>
          <Show when={props.notice.note}>{(note) => <span class="small muted">{note()}</span>}</Show>
          <Show when={props.notice.url}>
            {(url) => (
              <a class="small" href={url()} target="_blank" rel="noreferrer">
                {url()}
              </a>
            )}
          </Show>
          <pre class="diag">{props.notice.text}</pre>
        </div>
      </Show>
    </details>
  );
}
