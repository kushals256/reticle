/**
 * The documented install must not red-build a project that typechecks its own config.
 *
 * Two independent assignability failures, both invisible at runtime:
 *
 * 1. A structural `ReticleVitePlugin` must stay assignable to Vite's `Plugin` without importing
 *    `UserConfig` — that type contains `Plugin[]`, so naming it on our hook made tsc TS2321
 *    (excessive stack depth) the moment `reticle()` sat next to another plugin. The consumer check
 *    is an assignment to `Plugin` / `PluginOption` / `defineConfig` in this file.
 *
 * 2. The `config` hook's parameter typed `server.watch` as `{ ignored?: … }`, so Vite's
 *    `watch: null` (SvelteKit, Vite 7) was not accepted. Contravariance: a hook that cannot take
 *    what Vite passes is not a `Plugin`. svelte-check failed on that, not on the array position.
 *
 * The failure mode is the nastiest kind: the plugin WORKS at runtime, so nothing here or in any
 * fixture app catches it — only a user who typechecks their config in CI does. Hence a compile-time
 * test: it fails at `tsc`, which is the only place the defect is visible.
 */

import { describe, expect, it } from 'vitest';
import { defineConfig } from 'vite';
import type { ConfigEnv, Plugin, PluginOption, UserConfig, ViteDevServer } from 'vite';
import type { ViteDevServerLike } from './index.js';
import { JOURNAL_IGNORE, reticle } from './index.js';

const SERVE_ENV: ConfigEnv = { command: 'serve', mode: 'development' };

describe('public types stay consumable from a strict TS project', () => {
  it('accepts Vite’s real ViteDevServer where the plugin asks for one', () => {
    // The assertion IS the assignment: if the stand-in drifts back to a stricter shape, this file
    // stops compiling and `pnpm typecheck` goes red.
    const narrow: (server: ViteDevServer) => ViteDevServerLike = (server) => server;
    expect(typeof narrow).toBe('function');
  });

  it('drops into a Vite plugin array without a cast', () => {
    // What the docs tell a user to write. `plugins: [reticle()]` is a PluginOption[] in every real
    // config, and this is the exact position that produced TS2322 / TS2769.
    const plugins: PluginOption[] = [reticle()];
    expect(plugins).toHaveLength(1);
  });

  it('is Vite’s Plugin, not a stand-in that drifted away from it', () => {
    const plugin: Plugin = reticle();
    expect(plugin.name).toBe('reticle');
  });

  it('is accepted by defineConfig the way the docs write it', () => {
    const config = defineConfig({ plugins: [reticle()] });
    expect(config).toBeDefined();
  });

  it('accepts server.watch = null, which SvelteKit sets', () => {
    const incoming: UserConfig = { server: { watch: null } };
    // Second arg is Vite's ConfigEnv; a one-arg hook is still a Plugin config hook.
    const next = reticle().config?.(incoming, SERVE_ENV);
    expect(next).toBeDefined();
    const ignored = undefined !== next && null !== next ? next.server?.watch?.ignored : undefined;
    expect(Array.isArray(ignored) ? ignored : []).toContain(JOURNAL_IGNORE);
  });

  it('sits next to another plugin without exhausting the type checker', () => {
    // Importing UserConfig into ReticleVitePlugin made tsc TS2321 (excessive stack depth) the
    // moment reticle() shared a plugins array with vue() — `apps/electron-vue-pinia` on `pnpm build`.
    const other: Plugin = { name: 'other' };
    const config = defineConfig({ plugins: [other, reticle()] });
    expect(config).toBeDefined();
  });
});
