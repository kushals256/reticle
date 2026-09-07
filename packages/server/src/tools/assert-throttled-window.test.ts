/**
 * A starved tab and a missing element must not read alike.
 *
 * Reported from a hidden, throttled tab on a Next.js app (#521): after a hard reload the
 * backgrounded tab sat on its loading state forever because throttling starved hydration, and every
 * read saw the placeholder. `reticle_wait_for { text }` timed out as a near-miss that reads exactly
 * like "the code did not render" — the one answer an agent cannot distinguish from "the tab was
 * never allowed to run". The health envelope already rides alongside saying `throttled:true`, but
 * nothing connects it to the verdict an agent actually gates on.
 *
 * These tests pin the connection: a FAILED predicate waited out on a throttled tab names the
 * starvation in its own failureReason; a healthy tab's failure says exactly what it said before.
 *
 * Polarity (#796): throttle distrusts an empty look, not a positive match. `{ absent: true }`
 * against present content is `verified: "no"`; against nothing, it stays `"unknown"`.
 */
import { describe, expect, it } from 'vitest';
import { ReticleCommand, Verified, type CommandResult } from '@reticlehq/core';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import type { SessionManager } from '../session/session.js';
import { createFakeSession } from '../session/fake-session.js';

function depsWithThrottle(throttled: boolean): ToolDeps {
  const session = createFakeSession({
    bufferHealth: () => ({ total: 4, dropped: 0 }),
    elapsed: () => 1000,
    throttled: () => throttled,
    health: () => ({
      lastSeenMs: 5,
      throttled,
      focused: !throttled,
      ...(throttled ? { recommendation: 'refocus it' } : {}),
    }),
  });
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return { sessions: sessions as SessionManager } as unknown as ToolDeps;
}

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`${name} is not on the surface`);
  return found;
};

const missingSignal = {
  predicate: { kind: 'signal', name: 'compose:generated' },
  timeout_ms: 0,
};

describe('a failure waited out on a throttled tab says so', () => {
  for (const name of [ReticleTool.ASSERT, ReticleTool.WAIT_FOR]) {
    it(`${name} names starvation in the failureReason`, async () => {
      const result = (await tool(name).handler(depsWithThrottle(true), missingSignal)) as {
        pass: boolean;
        failureReason?: string;
      };
      expect(result.pass).toBe(false);
      expect(result.failureReason).toContain('throttled');
      expect(result.failureReason).toContain('re-check');
    });

    it(`${name} leaves a healthy tab's failure untouched`, async () => {
      const result = (await tool(name).handler(depsWithThrottle(false), missingSignal)) as {
        pass: boolean;
        failureReason?: string;
      };
      expect(result.pass).toBe(false);
      expect(result.failureReason).toBeTypeOf('string');
      expect(result.failureReason).not.toContain('throttled');
      expect(result.failureReason).not.toContain('re-check');
    });
  }

  it('the annotation is a suffix, so the original diagnosis still leads', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithThrottle(true),
      missingSignal,
    )) as { failureReason?: string };
    const reason = result.failureReason ?? '';
    expect(reason.startsWith('no signal matched')).toBe(true);
    expect(reason.indexOf('matched')).toBeLessThan(reason.indexOf('throttled'));
  });
});

/**
 * MATCH answers a fixed count. Throttle is on. The absence claim is the one whose polarity
 * inverts: finding the text is the failure, and finding nothing is the untrustworthy negative.
 */
function depsWithThrottledMatch(count: number): ToolDeps {
  const session = createFakeSession({
    bufferHealth: () => ({ total: 4, dropped: 0 }),
    elapsed: () => 1000,
    throttled: () => true,
    health: () => ({
      lastSeenMs: 5,
      throttled: true,
      focused: false,
      recommendation: 'refocus it',
    }),
    command: (name: string): Promise<CommandResult> =>
      Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result:
          name === ReticleCommand.MATCH
            ? {
                matched: count > 0,
                count,
                elements:
                  count > 0
                    ? [
                        {
                          ref: 'e1',
                          role: 'heading',
                          name: 'ProgrammingError',
                          states: [],
                          visible: true,
                        },
                      ]
                    : [],
              }
            : {},
      }),
  });
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return { sessions: sessions as SessionManager } as unknown as ToolDeps;
}

const absentErrorText = {
  predicate: { kind: 'text', contains: 'ProgrammingError', absent: true },
  timeout_ms: 0,
};

describe('an absence check on a throttled tab keeps the polarity of what it found', () => {
  it('returns no when matching elements are on the page', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithThrottledMatch(13),
      absentErrorText,
    )) as Record<string, unknown>;
    expect(result['pass']).toBe(false);
    expect(result['verified']).toBe(Verified.NO);
    expect(result['inconclusive']).toBeUndefined();
  });

  it('returns unknown when the look found nothing', async () => {
    const result = (await tool(ReticleTool.ASSERT).handler(
      depsWithThrottledMatch(0),
      absentErrorText,
    )) as Record<string, unknown>;
    expect(result['pass']).toBe(true);
    expect(result['verified']).toBe(Verified.UNKNOWN);
    expect(result['inconclusive']).toBeTypeOf('string');
  });
});
