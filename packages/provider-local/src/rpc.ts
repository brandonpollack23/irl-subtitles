/** Tiny typed request/response RPC over postMessage with progress events. */
export interface RpcRequest {
  id: number;
  method: string;
  payload: unknown;
}

export type RpcReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string } | { id: number; progress: unknown };

export type RpcHandler = (payload: never, ctx: { progress(p: unknown): void; transfer(t: Transferable[]): void }) => Promise<unknown>;

/**
 * Installs the handlers synchronously (a module worker can drop messages that arrive while its top-level awaits
 * run); each request waits for `ready`, e.g. the worker's runtime setup.
 */
export function serveRpc(handlers: Record<string, RpcHandler>, ready: Promise<unknown> = Promise.resolve()): void {
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  scope.onmessage = async (e: MessageEvent<RpcRequest>) => {
    const { id, method, payload } = e.data;
    const handler = handlers[method];
    let transfer: Transferable[] = [];
    const ctx = { progress: (p: unknown) => scope.postMessage({ id, progress: p } satisfies RpcReply), transfer: (t: Transferable[]) => (transfer = t) };
    try {
      if (!handler) throw new Error(`unknown method ${method}`);
      await ready;
      const result = await handler(payload as never, ctx);
      scope.postMessage({ id, ok: true, result } satisfies RpcReply, transfer);
    } catch (err) {
      scope.postMessage({ id, ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) } satisfies RpcReply);
    }
  };
}

/**
 * Runs handlers one at a time, in arrival order: a load that replaces a model waits for the inference using it, and
 * inference waits for a load in progress (irl-subt-kdl.14). A failure doesn't block what's queued behind it.
 */
export function serialLane(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

export class RpcClient {
  private nextId = 1;
  private pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void; progress?: (p: unknown) => void }>();
  private dead: Error | null = null;

  constructor(private readonly worker: Worker, private readonly name: string) {
    worker.onmessage = (e: MessageEvent<RpcReply>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      if ("progress" in e.data) return p.progress?.(e.data.progress);
      this.pending.delete(e.data.id);
      if (e.data.ok) p.ok(e.data.result);
      else p.fail(new Error(e.data.error));
    };
    worker.onerror = (e) => this.failAll(new Error(`${name} worker crashed: ${e.message || "unknown error"}`));
  }

  private failAll(err: Error) {
    this.dead = err;
    for (const p of this.pending.values()) p.fail(err);
    this.pending.clear();
  }

  get alive(): boolean {
    return !this.dead;
  }

  call<T>(method: string, payload: unknown, opts: { transfer?: Transferable[]; progress?: (p: unknown) => void } = {}): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise<T>((ok, fail) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, fail, progress: opts.progress });
      this.worker.postMessage({ id, method, payload } satisfies RpcRequest, opts.transfer ?? []);
    });
  }

  terminate(): void {
    this.worker.terminate();
    this.failAll(new Error(`${this.name} worker terminated`));
  }
}
