import { THROTTLED_STARVED_NOTE } from '@reticlehq/core';
import type { EvalResult, Predicate } from './predicate-eval.js';

/**
 * A miss on a throttled tab is not a missing render. The browser has starved the tab, so a timeout
 * there may mean it never ran — which must not look like "the text is absent".
 *
 * Sets `inconclusive` only. The PROSE is already handled one layer up by `annotateStarvedFailure`
 * (session-health.ts), which suffixes the same fact onto the failureReason so the concrete
 * diagnosis still leads; writing it here as well would put the sentence in every throttled failure
 * twice. What was missing was never the sentence — it was the FIELD an agent gates on, so a starved
 * wait graded `assertion-failed` and sent somebody to fix working code.
 *
 * Polarity: throttle distrusts an EMPTY look, not a positive match. `{ absent: true }` that found
 * matching elements is a confirmed failure; the same claim that found nothing stays inconclusive,
 * because "I did not find it" may mean "I could not look". A presence pass is still trusted — those
 * elements were found.
 *
 * Idempotent, and a more specific `inconclusive` (unreadable locator, superseded window) is never
 * overwritten.
 */
export function annotateThrottledMiss(
  session: { throttled?(): boolean },
  result: EvalResult,
  predicate: Predicate,
): EvalResult {
  if (true !== session.throttled?.()) return result;
  if (result.inconclusive !== undefined) return result;
  const absence = 'absent' in predicate && true === predicate.absent;
  if (absence) {
    return true === result.pass ? { ...result, inconclusive: THROTTLED_STARVED_NOTE } : result;
  }
  if (result.pass) return result;
  return { ...result, inconclusive: THROTTLED_STARVED_NOTE };
}
