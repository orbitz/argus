/**
 * Verdict over a commit's status checks: check runs (Actions etc.) plus commit
 * statuses, the two sources GitHub branch protection reads. There is no single
 * GitHub endpoint that combines them, so callers fetch both and summarize here.
 */
export interface CheckSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  /** success when everything settled green, failure on any red, pending otherwise. */
  state: 'success' | 'failure' | 'pending';
}

/**
 * Count check runs and commit statuses into one verdict. `skipped` counts as
 * passed (a matrix entry that never ran is not a problem); anything completed
 * that is neither green nor skipped counts as failed; anything still running
 * counts as pending.
 */
export function summarizeChecks(
  checks: Array<{ status: string; conclusion: string | null }>,
  combinedStatus: { state: string; statuses: Array<{ state: string }> }
): CheckSummary {
  let passed = 0;
  let failed = 0;
  let pending = 0;

  for (const check of checks) {
    if (check.status === 'completed') {
      if (check.conclusion === 'success' || check.conclusion === 'skipped') {
        passed++;
      } else if (
        check.conclusion === 'failure' ||
        check.conclusion === 'cancelled' ||
        check.conclusion === 'timed_out'
      ) {
        failed++;
      } else {
        pending++;
      }
    } else {
      pending++;
    }
  }

  for (const status of combinedStatus.statuses) {
    if (status.state === 'success') {
      passed++;
    } else if (status.state === 'failure' || status.state === 'error') {
      failed++;
    } else {
      pending++;
    }
  }

  const total = passed + failed + pending;

  let state: CheckSummary['state'] = 'success';
  if (failed > 0) {
    state = 'failure';
  } else if (pending > 0) {
    state = 'pending';
  }

  return { total, passed, failed, pending, state };
}
