/**
 * Per-request performance counters.
 *
 * The PR route's `span()` helper measures wall-clock for regions of the handler, but the
 * expensive work happens several layers down: git subprocesses in `git.ts`, Shiki tokenizing
 * in `syntax-highlighter.ts`. Threading a stats object through every call signature would
 * touch a lot of unrelated code, so the counters ride along in an AsyncLocalStorage instead.
 *
 * AsyncLocalStorage rather than a module-level tally on purpose: the prefetch job and any
 * concurrent request run in the same process, and a plain counter would attribute their git
 * spawns to whichever request happened to read it next.
 *
 * Every `bump` is a no-op outside a `withCounters` scope, so nothing here changes behaviour
 * for callers that don't opt in.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface PerfCounters {
  /** Number of `git` subprocesses spawned. */
  gitSpawns: number;
  /** Total wall-clock across those subprocesses (they run sequentially today). */
  gitMs: number;
  /** Subset of the above that talk to GitHub (`fetch`/`clone`) rather than working locally. */
  gitNetworkSpawns: number;
  /** Wall-clock across the network-bound git subprocesses. */
  gitNetworkMs: number;
  /** Lines handed to Shiki. Counts whole-file context passes, not just changed lines. */
  linesTokenized: number;
  /** Wall-clock inside Shiki's (synchronous) tokenizer. */
  shikiMs: number;
  /** Number of separate Shiki tokenize passes. */
  shikiCalls: number;
}

function emptyCounters(): PerfCounters {
  return {
    gitSpawns: 0,
    gitMs: 0,
    gitNetworkSpawns: 0,
    gitNetworkMs: 0,
    linesTokenized: 0,
    shikiMs: 0,
    shikiCalls: 0,
  };
}

const storage = new AsyncLocalStorage<PerfCounters>();

/**
 * Begin a counter scope covering the rest of the current async execution context, and return
 * the (live) counters object to read at the end.
 *
 * `enterWith` rather than `run` so callers don't have to wrap their whole body in a callback;
 * a route handler is already its own async context, so the scope ends naturally with the
 * request. Note the returned object keeps mutating if the caller left work un-awaited — that
 * is deliberate, so fire-and-forget work shows up rather than vanishing.
 */
export function startCounters(): PerfCounters {
  const counters = emptyCounters();
  storage.enterWith(counters);
  return counters;
}

/** The active counters, or undefined outside a `withCounters` scope. */
export function currentCounters(): PerfCounters | undefined {
  return storage.getStore();
}

/** Add to a counter if one is active. Safe to call from anywhere. */
export function bump(field: keyof PerfCounters, amount: number): void {
  const counters = storage.getStore();
  if (counters) counters[field] += amount;
}
