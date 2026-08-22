// Benchmark regression gate. Compares the FRESH raw results (written by bench-all.mjs) against the
// PREVIOUS row in bench/history.jsonl and fails (exit 1) on a regression. Policy (locked with the
// user): hard gate vs last + a catch-rate floor. The deterministic passes (OBSERVATION-COST + REPLAY)
// block; the AGENT-LOOP pass (a paid LLM loop) is never gated here.
// (Raw JSON keys keep the legacy A/B/C codes — ranLayerA, layer_c — for data continuity.)
//
//   node bench/harness/bench-all.mjs --full && node bench/harness/gate.mjs
//
// Hard fails:
//   - catch-rate < 1.0, or any false positive (OBSERVATION-COST — only when analysis.json is present)
//   - efficiency drops > VE_TOL vs the last row (OBSERVATION-COST)
//   - selector detection not full, or consequence detection not full (REPLAY)
//   - per-run replay tokens rise > TOKEN_TOL vs the last row (REPLAY)
import { readFileSync, existsSync } from 'node:fs';
import { TOKEN_TOL, declaredBudgetOf, tokenVerdict } from './token-budget.mjs';
import { parityVerdict } from './playwright-parity.mjs';

const VE_TOL = 0.03; // VE may dip at most 3% vs last (noise) before it's a regression

function readRaw(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function historyRows() {
  if (!existsSync('bench/history.jsonl')) return [];
  return readFileSync('bench/history.jsonl', 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** The previous recorded row (the baseline we must not regress against), or null on first run. */
function lastRow() {
  return historyRows().at(-1) ?? null;
}

/**
 * A row further back than the previous one, so a drift that lands once and then holds is visible.
 *
 * The last-row comparison cannot see its own accumulation. A change that costs 3% is recorded, and
 * every run after it is measured against the recorded, worse number and passes forever. That is not
 * hypothetical: it is exactly how #283 went unnoticed, and the tolerance was never exceeded once.
 *
 * Reported rather than enforced at the same tolerance, because a rise here is not automatically a
 * defect. #283's own cost turned out to be bought: the snapshot delta started carrying the refs an
 * agent needs to act, which is more tokens and a better answer. A gate that cannot tell "we paid for
 * this" from "we regressed" will either block good changes or be muted, and both end the same way.
 * So: always print the drift, and fail only when it has grown past the point where nobody has
 * decided anything.
 */
const REFERENCE_VERSION = process.env.BENCH_REFERENCE_VERSION ?? '2.7.0';
const REFERENCE_TOL = 0.1;

function referenceRow() {
  return historyRows().find((r) => String(r.version) === REFERENCE_VERSION) ?? null;
}

/** Parse a "3/3" detection-rate string into { detected, total }. */
function parseRate(rate) {
  if (typeof rate !== 'string') return null;
  const m = /^(\d+)\/(\d+)$/.exec(rate);
  return m === null ? null : { detected: Number(m[1]), total: Number(m[2]) };
}

const failures = [];
const scorecard = [];
const prev = lastRow();

/**
 * Which dimensions were actually COMPARED against a baseline, and which had none to compare against.
 *
 * This gate used to end with "✓ gate passed — no regression vs the last baseline" whether or not a
 * single comparison had happened. It cannot happen today: every `layer_c` comparison reads
 * `prev.layer_c`, and the most recent `history.jsonl` row does not have that key — the last nine rows
 * do, the last row does not — so `lastC` is null, every `if (last !== null)` is skipped, and the gate
 * reports a clean bill of health having checked nothing but the absolute floors.
 *
 * A regression gate that cannot see a regression, announcing that it found none, is precisely the
 * false green this whole project exists to catch. So: count the comparisons, and say what was
 * actually compared. The absolute floors (detection must be full) still gate on their own.
 */
const compared = [];
const uncompared = [];
/**
 * A dimension counts as COMPARED only when both sides of the comparison exist.
 *
 * The paragraph above is about a missing BASELINE. The same hole exists on the fresh side and was
 * open until a run proved it: `replay-bench` errored every row, wrote no number, and the gate printed
 *
 *   Replay · tokens/run    237            → null
 *   ✓ gate passed — 5 dimension(s) compared against the last baseline, no regression
 *
 * because the guard read the baseline (237, present) and never looked at what this pass measured.
 * `null > 237 * 1.05` is false, so the comparison silently passed. The one dimension whose whole job
 * is catching a token regression reported no regression having measured nothing.
 *
 * A baseline with no fresh number beside it is also a FAILURE, not merely an unmeasured dimension:
 * the outer `if (cost !== null)` already established that this pass was supposed to produce one.
 */
const note = (dimension, baseline, fresh) => {
  const missing = (v) => v === null || v === undefined;
  if (missing(baseline) || missing(fresh)) {
    uncompared.push(dimension);
    if (!missing(baseline) && missing(fresh)) {
      failures.push(
        `${dimension}: this pass measured nothing (baseline ${String(baseline)}), so the comparison ` +
          'did not happen — re-run the benchmark rather than reading this as no regression',
      );
    }
    return;
  }
  compared.push(dimension);
};
// Only gate layers that ran THIS pass (a stale analysis.json must not be gated on a Layer-C pass).
const manifest = readRaw('bench/raw/bench-run.json');
const ranLayerA = manifest === null ? true : manifest.ranLayerA === true;

// ---- OBSERVATION-COST pass (scripted observation, "Layer A") — only when freshly run this pass ----
const analysis = ranLayerA ? readRaw('bench/raw/analysis.json') : null;
if (analysis !== null) {
  const reticle = analysis.per_tool?.reticle ?? {};
  const realRegressions = Object.values(analysis.per_scenario ?? {}).filter(
    (s) => s.expected_detect === true && s.by_tool?.reticle?.verdict !== 'NOT MEASURED',
  ).length;
  const rcr = realRegressions ? +(reticle.true_positives / realRegressions).toFixed(3) : null;
  const ve = reticle.avg_tokens_o200k
    ? +(reticle.true_positives / (reticle.avg_tokens_o200k / 1000)).toFixed(2)
    : null;
  const fp = reticle.false_positives ?? 0;

  if (rcr === null || rcr < 1.0) failures.push(`RCR floor: reticle RCR=${rcr} (must be 1.0)`);
  if (fp > 0) failures.push(`false positives: reticle FP=${fp} (must be 0)`);

  // The claim the product is SOLD on, and until now the only one nothing defended: every other
  // dimension here compares us against ourselves, so none would notice the day we drift past
  // Playwright. See playwright-parity.mjs for why the two halves are not symmetric.
  const parity = parityVerdict({
    reticle,
    playwright: analysis.per_tool?.playwright ?? {},
    declaredCostlier: analysis.cost?.playwright_parity?.costlier_because,
  });
  if (!parity.ok) failures.push(parity.reason);
  scorecard.push([
    'Observe · vs Playwright',
    `${analysis.per_tool?.playwright?.avg_tokens_o200k ?? '—'} tok @ ${analysis.per_tool?.playwright?.detection_accuracy ?? '—'}`,
    `${reticle.avg_tokens_o200k ?? '—'} tok @ ${reticle.detection_accuracy ?? '—'}`,
  ]);
  const lastVe = prev?.per_tool?.reticle?.ve ?? null;
  if (lastVe !== null && ve !== null && ve < lastVe * (1 - VE_TOL)) {
    failures.push(
      `VE regressed: ${ve} < ${lastVe} (−${(((lastVe - ve) / lastVe) * 100).toFixed(1)}%)`,
    );
  }
  scorecard.push(['Observe · catch-rate', prev?.per_tool?.reticle?.rcr ?? '—', rcr]);
  scorecard.push(['Observe · false-positives', '0', fp]);
  note('Observe · efficiency', lastVe, ve);
  scorecard.push(['Observe · efficiency', lastVe ?? '—', ve]);
  // The same number against a fixed point, so accumulation cannot hide behind a moving baseline.
  const refRow = referenceRow();
  const refVe = refRow?.per_tool?.reticle?.ve ?? null;
  if (refVe !== null && ve !== null) {
    const drift = ((ve - refVe) / refVe) * 100;
    scorecard.push([
      `Observe · efficiency vs ${REFERENCE_VERSION}`,
      refVe,
      `${ve} (${drift >= 0 ? '+' : ''}${drift.toFixed(1)}%)`,
    ]);
    if (ve < refVe * (1 - REFERENCE_TOL)) {
      failures.push(
        `VE has drifted ${(((refVe - ve) / refVe) * 100).toFixed(1)}% below the ${REFERENCE_VERSION} reference ` +
          `(${ve} vs ${refVe}). Each step passed the last-row check; together they did not. Either attribute ` +
          `it, or move BENCH_REFERENCE_VERSION forward deliberately and say why.`,
      );
    }
  }
} else {
  scorecard.push(['Observation-cost', '—', 'not run this pass (advisory skip)']);
}

// ---- REPLAY pass (deterministic replay, "Layer C") — always gated when the raws are present ----
const cost = readRaw('bench/raw/replay-bench.json');
const selector = readRaw('bench/raw/replay-detect.json');
const consequence = readRaw('bench/raw/replay-detect-consequence.json');
const lastC = prev?.layer_c ?? null;

if (selector !== null) {
  const r = parseRate(selector.detection_rate);
  if (r === null || r.detected < r.total) {
    failures.push(`selector detection not full: ${selector.detection_rate}`);
  }
  const lastR = parseRate(lastC?.selector_detection);
  if (lastR !== null && r !== null && r.total < lastR.total) {
    failures.push(`selector scenarios dropped: ${r.total} < ${lastR.total}`);
  }
  note('Replay · selector', lastC?.selector_detection, selector);
  scorecard.push(['Replay · selector', lastC?.selector_detection ?? '—', selector.detection_rate]);
}
if (consequence !== null) {
  const r = parseRate(consequence.detection_rate);
  if (r === null || r.detected < r.total) {
    failures.push(`consequence detection not full: ${consequence.detection_rate}`);
  }
  note('Replay · consequence', lastC?.consequence_detection, consequence);
  scorecard.push([
    'Replay · consequence',
    lastC?.consequence_detection ?? '—',
    consequence.detection_rate,
  ]);
}
const stateOracle = readRaw('bench/raw/replay-detect-state.json');
if (stateOracle !== null) {
  const r = parseRate(stateOracle.detection_rate);
  if (r === null || r.detected < r.total) {
    failures.push(`state-oracle detection not full: ${stateOracle.detection_rate}`);
  }
  const lastR = parseRate(lastC?.state_detection);
  if (lastR !== null && r !== null && r.total < lastR.total) {
    failures.push(`state-oracle scenarios dropped: ${r.total} < ${lastR.total}`);
  }
  note('Replay · state', lastC?.state_detection, stateOracle);
  scorecard.push(['Replay · state', lastC?.state_detection ?? '—', stateOracle.detection_rate]);
}
if (cost !== null) {
  const now = cost.per_run?.reticle_replay_mean_tokens ?? null;
  const last = lastC?.replay_mean_tokens ?? null;
  // A rise is either chosen or unnoticed, and the gate cannot tell those apart on its own. A run
  // that MEANT to spend more declares it; anything else is drift. See token-budget.mjs.
  const budget = declaredBudgetOf(cost);
  const tokens = tokenVerdict({ now, last, budget });
  if (!tokens.ok) failures.push(tokens.reason);
  note('Replay · tokens/run', last, now);
  scorecard.push([
    'Replay · tokens/run',
    last ?? '—',
    budget > 0 ? `${now} (+${budget} declared)` : now,
  ]);
}

// ---- Report ----
console.log('\nBenchmark gate — fresh vs last baseline');
console.log('─'.repeat(56));
for (const [metric, was, now] of scorecard) {
  console.log(`  ${String(metric).padEnd(22)} ${String(was).padEnd(14)} → ${now}`);
}
console.log('─'.repeat(56));
if (analysis === null && cost === null && selector === null && consequence === null) {
  console.error('✗ no fresh results found — run `node bench/harness/bench-all.mjs` first.');
  process.exit(1);
}
if (failures.length > 0) {
  console.error(`\n✗ GATE FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

// Say what was actually compared. "No regression" over zero comparisons is not a result.
if (uncompared.length > 0) {
  console.log(`\n⚠ ${uncompared.length} dimension(s) had NO baseline to compare against:`);
  for (const d of uncompared) console.log(`  - ${d}`);
  console.log(
    `  The last bench/history.jsonl row (${prev?.version ?? 'none'}, ${prev?.date ?? 'no date'}) does not carry these keys,\n` +
      '  so they were checked against absolute floors only — a regression WITHIN the floor is invisible.\n' +
      '  Record a fresh baseline with `node bench/harness/record.mjs` after a full pass.',
  );
}
console.log(
  0 === compared.length
    ? `\n✓ absolute floors hold — but NOTHING was compared against a baseline, so this run says nothing about regression.`
    : `\n✓ gate passed — ${compared.length} dimension(s) compared against the last baseline, no regression.`,
);
process.exit(0);
