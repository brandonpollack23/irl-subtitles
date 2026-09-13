/// <reference lib="webworker" />
import { AutoModelForCausalLM, AutoTokenizer, TextStreamer, type PreTrainedModel, type PreTrainedTokenizer, type Tensor } from "@huggingface/transformers";
import { catalogEntry } from "../catalog";
import { setupRuntime } from "../ort-env";
import { serveRpc } from "../rpc";

/** Summary LLMs (Gemma 4, Qwen3.5) on WebGPU; runs only after capture ends (plan.md §6.1). */
setupRuntime();

let current: { id: string; model: PreTrainedModel; tokenizer: PreTrainedTokenizer } | null = null;
let stopRequested = false;

async function load(modelId: string, progress: (p: unknown) => void) {
  if (current?.id === modelId) return;
  await current?.model.dispose().catch(() => undefined);
  current = null;
  const entry = catalogEntry(modelId);
  if (!entry || entry.manifest.adapter !== "tjs-llm" || entry.manifest.source.type !== "hf") throw new Error(`not a summary model: ${modelId}`);
  const { repo, revision } = entry.manifest.source;
  const dtype = (entry.manifest.params?.dtype as Record<string, unknown> | undefined)?.webgpu;
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(repo, { revision } as never),
    AutoModelForCausalLM.from_pretrained(repo, { revision, device: "webgpu", ...(dtype ? { dtype } : {}), progress_callback: progress } as never),
  ]);
  current = { id: modelId, model, tokenizer };
}

serveRpc({
  "llm.load": async (p: { modelId: string }, ctx) => load(p.modelId, ctx.progress),

  "llm.countTokens": async (p: { text: string }) => {
    if (!current) throw new Error("LLM not loaded");
    return (current.tokenizer.encode(p.text) as number[]).length;
  },

  "llm.generate": async (p: { messages: { role: string; content: string }[]; maxNewTokens: number; disableThinking?: boolean }, ctx) => {
    if (!current) throw new Error("LLM not loaded");
    stopRequested = false;
    const { tokenizer, model } = current;
    const inputs = tokenizer.apply_chat_template(p.messages as never, { add_generation_prompt: true, return_dict: true, enable_thinking: p.disableThinking ? false : undefined } as never) as unknown as { input_ids: Tensor };
    let tokens = 0;
    const t0 = performance.now();
    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: () => {
        tokens++;
        if (tokens % 16 === 0) ctx.progress({ tokens, tps: (tokens * 1000) / (performance.now() - t0) });
      },
    } as never);
    const output = (await model.generate({
      ...inputs,
      max_new_tokens: p.maxNewTokens,
      do_sample: false,
      repetition_penalty: 1.05,
      streamer,
      stopping_criteria: [() => [stopRequested]] as never,
    } as never)) as Tensor;
    const promptLen = inputs.input_ids.dims.at(-1)!;
    const all = output.tolist() as bigint[][];
    const newIds = all[0]!.slice(promptLen).map(Number);
    const text = tokenizer.decode(newIds, { skip_special_tokens: true });
    return { text, tokens: newIds.length, ms: performance.now() - t0 };
  },

  "llm.stop": async () => {
    stopRequested = true;
  },

  "release": async () => {
    await current?.model.dispose().catch(() => undefined);
    current = null;
  },
});
