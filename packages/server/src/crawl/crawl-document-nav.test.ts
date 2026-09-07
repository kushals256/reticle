/**
 * A server-rendered MPA reconnects the SDK on every full page load. Crawl used to treat that as a
 * fatal session replace, so it could not walk past the first link.
 *
 * Same-id reconnect (sessionStorage survived, the document did not) rejects the in-flight ACT with
 * `SessionReplacedError` — deliberately, because re-issuing a write is a double submit. The click
 * already happened; the page that took over is the one to keep driving. SPA logins that stay on one
 * document and grow the surface are a different case (see crawl-revealed.test.ts) and must still
 * stop and say so rather than inventing a frontier walk.
 */
import { describe, expect, it } from 'vitest';
import { EventType, ReticleCommand, type CommandResult, type ReticleEvent } from '@reticlehq/core';
import { SessionReplacedError } from '../session/pending-commands.js';
import { crawl, type CrawlSession } from './crawl.js';

const noSleep = (): Promise<void> => Promise.resolve();

const HOME = 'link "About" (ref=e1)';
const ABOUT = 'link "Contact" (ref=e2)';
const ABOUT_REUSED_REF = 'link "Contact" (ref=e1)';

const ok = (result: unknown): Promise<CommandResult> =>
  Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });

/**
 * Two server-rendered pages. Clicking the first link tears the document down; the next SNAPSHOT is
 * the destination. Models the same-id HELLO the MPA SDK actually sends.
 */
class MpaSession implements CrawlSession {
  tree = HOME;
  acts: string[] = [];
  #clock = 0;
  #buffer: ReticleEvent[] = [];

  elapsed(): number {
    return this.#clock;
  }

  eventsSince(since: number): ReticleEvent[] {
    return this.#buffer.filter((e) => e.t > since);
  }

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === ReticleCommand.SNAPSHOT) return ok({ tree: this.tree });
    if (name === ReticleCommand.ACT) {
      const ref = 'string' === typeof args['ref'] ? args['ref'] : '';
      this.acts.push(ref);
      this.#clock += 1;
      if ('e1' === ref && HOME === this.tree) {
        this.tree = ABOUT;
        this.#buffer.push({
          t: this.#clock,
          type: EventType.ROUTE_CHANGE,
          sessionId: 's',
          data: { to: '/about' },
        });
        return Promise.reject(new SessionReplacedError('session replaced by a newer connection'));
      }
      this.#buffer.push({
        t: this.#clock,
        type: EventType.DOM_ADDED,
        sessionId: 's',
        data: {},
      });
      return ok({ dispatched: true });
    }
    return ok({});
  }
}

describe('crawl follows a document navigation instead of dying', () => {
  it('does not throw when the click that caused the reload is rejected as replaced', async () => {
    const session = new MpaSession();
    await expect(crawl(session, { maxSteps: 2 }, noSleep)).resolves.toMatchObject({
      stepsRun: 2,
    });
  });

  it('walks the destination page within the remaining budget', async () => {
    const session = new MpaSession();
    const report = await crawl(session, { maxSteps: 2 }, noSleep);
    expect(session.acts).toEqual(['e1', 'e2']);
    expect(report.visited).toEqual(['link "About"', 'link "Contact"']);
    expect(report.stepsRun).toBe(2);
  });

  it('does not report the navigating link as a dead control', async () => {
    const session = new MpaSession();
    const report = await crawl(session, { maxSteps: 2 }, noSleep);
    expect(report.counts.deadControls).toBe(0);
    expect(report.anomalies).toEqual([]);
  });

  it('still throws when the transport died for any other reason', async () => {
    const session: CrawlSession = {
      elapsed: () => 0,
      eventsSince: () => [],
      command: (name) => {
        if (name === ReticleCommand.SNAPSHOT) return ok({ tree: HOME });
        return Promise.reject(new Error('session disconnected'));
      },
    };
    await expect(crawl(session, { maxSteps: 1 }, noSleep)).rejects.toThrow(/session disconnected/);
  });

  it("clicks the destination even when it reuses the departed page's first ref", async () => {
    class ReusedRefSession implements CrawlSession {
      tree = HOME;
      elapsed(): number {
        return 0;
      }
      eventsSince(): ReticleEvent[] {
        return [];
      }
      command(name: string): Promise<CommandResult> {
        if (name === ReticleCommand.SNAPSHOT) return ok({ tree: this.tree });
        if (name === ReticleCommand.ACT) {
          this.tree = ABOUT_REUSED_REF;
          return Promise.reject(new SessionReplacedError('session replaced by a newer connection'));
        }
        return ok({});
      }
    }
    const report = await crawl(new ReusedRefSession(), { maxSteps: 2 }, noSleep);
    expect(report.visited).toEqual(['link "About"', 'link "Contact"']);
  });
});
