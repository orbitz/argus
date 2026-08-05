/**
 * A pool of worker threads that tokenize diff lines off the main thread.
 *
 * Shiki's codeToTokens is synchronous CPU work, so in-process it blocks the event loop for
 * the whole render — on a 70-file PR that was ~10s during which the server answered nothing
 * else, and no amount of Promise.all around the callers helped, because there was only ever
 * one thread to run on. Here each worker holds its own highlighter and the files really do
 * tokenize in parallel.
 *
 * Everything degrades to the in-process path: if a worker fails to spawn, dies, or reports an
 * error, that request is answered inline instead (see syntax-highlighter.ts). The pool is an
 * optimization, never a dependency.
 */

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { config } from '../config.js';

export interface WorkerResult {
  html: string[];
  /** Tokenize time on the worker, for the caller to fold into its own perf counters. */
  ms: number;
}

interface Pending {
  resolve: (result: WorkerResult) => void;
  reject: (err: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
  /** Ids dispatched to this worker, so a crash only fails the jobs it was actually holding. */
  jobs: Set<number>;
}

interface QueueEntry {
  lines: string[];
  lang: string;
  pending: Pending;
}

let workers: PoolWorker[] | null = null;
let disabled = false;
let nextId = 1;
const inflight = new Map<number, Pending>();
const queue: QueueEntry[] = [];

// Dev runs the TypeScript sources through tsx; production runs the compiled output. Pick the
// siblings that match whichever form of this module is executing — the worker cannot work
// this out for itself, so it receives coreUrl in workerData.
const SIBLING_EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

function siblingUrl(name: string): URL {
  return new URL(`./${name}${SIBLING_EXT}`, import.meta.url);
}

/**
 * The subset of this process's execArgv a worker should inherit.
 *
 * Node hands workers the parent's execArgv wholesale, which is wrong here in both
 * directions: the dev runner's `--watch` would give every worker its own file watcher, and
 * `npx tsx`'s `--eval <script>` would make each worker re-run the entry point. Only the
 * loader flags matter — without them the worker resolves `./highlight-core.js` literally and
 * fails to find the TypeScript source next to it.
 */
function workerExecArgv(): string[] {
  const kept: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const arg = process.execArgv[i];
    if (arg === '--require' || arg === '-r' || arg === '--import') {
      const value = process.execArgv[i + 1];
      if (value !== undefined) {
        kept.push(arg, value);
        i++;
      }
    } else if (arg.startsWith('--require=') || arg.startsWith('--import=')) {
      kept.push(arg);
    }
  }
  return kept;
}

function poolSize(): number {
  const configured = config.diff.highlightWorkers;
  if (configured > 0) return configured;
  // Leave a core for the event loop and for whatever else the box is doing. Capped well
  // below the core count because each worker is a V8 isolate plus an Oniguruma WASM heap,
  // ~57MB resident whatever it is doing; past four the memory costs more than the extra
  // parallelism is worth on a typical PR. Raise HIGHLIGHT_WORKERS if you have the RAM.
  return Math.max(1, Math.min(4, os.cpus().length - 2));
}

function spawn(): PoolWorker | null {
  try {
    const worker = new Worker(siblingUrl('highlight-worker'), {
      execArgv: workerExecArgv(),
      workerData: { coreUrl: siblingUrl('highlight-core').href },
    });
    const entry: PoolWorker = { worker, busy: false, jobs: new Set() };

    worker.on('message', (msg: any) => {
      if (msg.id === -1) return; // boot handshake
      const pending = inflight.get(msg.id);
      inflight.delete(msg.id);
      entry.jobs.delete(msg.id);
      entry.busy = false;
      worker.unref();
      if (pending) {
        if (msg.error) pending.reject(new Error(msg.error));
        else pending.resolve({ html: msg.html, ms: msg.ms });
      }
      drain();
    });

    const fail = (err: Error) => {
      // A dead worker takes its own in-flight job with it; reject that one so its caller
      // falls back inline, and drop the worker so later jobs go to a healthy one. Jobs on
      // other workers are untouched — they are still perfectly alive.
      entry.busy = false;
      worker.unref();
      if (workers) workers = workers.filter((w) => w !== entry);
      for (const id of entry.jobs) {
        const pending = inflight.get(id);
        inflight.delete(id);
        pending?.reject(err);
      }
      entry.jobs.clear();
      // Everything crashed: stop spawning and let every caller highlight in-process.
      if (workers && workers.length === 0) disabled = true;
      drain();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => {
      if (code !== 0) fail(new Error(`highlight worker exited with code ${code}`));
    });

    // Idle workers must not hold the process open, but a worker with a job in flight must:
    // unref'd, an otherwise-empty event loop would let Node exit with the reply still coming.
    // ref() goes back on at dispatch (see drain).
    worker.unref();
    return entry;
  } catch (err: any) {
    console.error('Failed to spawn highlight worker:', err.message);
    return null;
  }
}

function ensurePool(): PoolWorker[] | null {
  if (disabled) return null;
  if (!workers) {
    const size = poolSize();
    const spawned: PoolWorker[] = [];
    for (let i = 0; i < size; i++) {
      const w = spawn();
      if (w) spawned.push(w);
    }
    if (spawned.length === 0) {
      disabled = true;
      return null;
    }
    workers = spawned;
  }
  return workers;
}

function drain(): void {
  if (!workers) return;

  // Nothing left alive to run them on. These must be rejected rather than left sitting in the
  // queue: a queued job that never settles is a request that never responds, where falling
  // back to in-process highlighting would merely have been slow.
  if (workers.length === 0) {
    disabled = true;
    while (queue.length > 0) {
      queue.shift()!.pending.reject(new Error('highlight pool has no live workers'));
    }
    return;
  }

  while (queue.length > 0) {
    const idle = workers.find((w) => !w.busy);
    if (!idle) return;
    const job = queue.shift()!;
    const id = nextId++;
    idle.busy = true;
    idle.worker.ref();
    idle.jobs.add(id);
    inflight.set(id, job.pending);
    idle.worker.postMessage({ id, lines: job.lines, lang: job.lang });
  }
}

export function poolAvailable(): boolean {
  return !disabled && config.diff.highlightWorkers !== 0;
}

/**
 * Tokenize on a worker. Rejects if the pool is unavailable or the job failed, which callers
 * must treat as "do it inline" rather than as an error.
 */
export function highlightOnWorker(lines: string[], lang: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const pool = ensurePool();
    if (!pool) {
      reject(new Error('highlight pool unavailable'));
      return;
    }
    queue.push({ lines, lang, pending: { resolve, reject } });
    drain();
  });
}

/**
 * Build each worker's highlighter ahead of the first request.
 *
 * createHighlighter takes the better part of a second, and without this the first PR load
 * after a restart pays it on every worker at once.
 */
export function warmHighlightPool(): void {
  if (!poolAvailable()) return;
  const pool = ensurePool();
  if (!pool) return;
  for (let i = 0; i < pool.length; i++) {
    highlightOnWorker(['warm'], 'typescript').catch(() => {});
  }
}

/** Test-only handle on the live workers, so a test can kill them mid-flight. */
export function __workersForTest(): PoolWorker[] {
  return workers ?? [];
}
