#!/usr/bin/env node
/**
 * Regression tests for verify-plan.mjs.
 *
 * Run:  node test-verify-plan.mjs        (or: node --test scripts/)
 *
 * Every case below pins a defect that once shipped, so a future edit to verify-plan.mjs cannot
 * quietly reintroduce it. Fixtures are built in a temp dir — nothing is written to the repo.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { after, describe } from 'node:test';

import { expandIds, normalizeIdSpec, parseReadmeWaveRows, PlanSpecError } from './verify-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(HERE, 'verify-plan.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-plan-tests-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const README = (rows) => `# Test — Master Plan (multi-wave)

Status: not started

## Wave files

| Wave | File | Theme | Backlog rows |
|---|---|---|---|
${rows}

## Status tracking (wave rollup)

| Wave | Status | Notes |
|---|---|---|
| 0 | [ ] | |
`;

const WAVE = (n, tasks) => `# Wave ${n} — Theme

## Status tracking — Wave ${n}

Status: not started

${tasks}

### Task W${n}-GATE — Wave verification gate

1. Build exits 0.
`;

let seq = 0;

/**
 * waves: { n: tasksMarkdown }. readmeWaves: which wave numbers the README lists (default all).
 * rowsFor: optional { n: "F1-F2" } to fill the backlog-rows column.
 */
function build(waves, { readmeWaves, rowsFor = {}, extra = {} } = {}) {
  const folder = path.join(TMP, `plan-${seq++}`);
  fs.mkdirSync(folder, { recursive: true });
  const listed = readmeWaves ?? Object.keys(waves).map(Number);
  const rows = listed
    .map((n) => `| ${n} | [wave-${n}-theme.md](wave-${n}-theme.md) | Theme | ${rowsFor[n] ?? 'rows'} |`)
    .join('\n');
  fs.writeFileSync(path.join(folder, 'README.md'), README(rows));
  for (const [n, tasks] of Object.entries(waves)) {
    fs.writeFileSync(path.join(folder, `wave-${n}-theme.md`), WAVE(n, tasks));
  }
  for (const [name, body] of Object.entries(extra)) {
    fs.writeFileSync(path.join(folder, name), body);
  }
  return folder;
}

function run(folder, ...args) {
  const r = spawnSync(process.execPath, [VERIFY, folder, '--root', TMP, ...args], {
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('expandIds', () => {
  test('plain range', () => assert.deepEqual(expandIds('F1-F3'), ['F1', 'F2', 'F3']));

  test('bare tokens pass through', () =>
    assert.deepEqual(expandIds('W0-GATE,FINAL'), ['W0-GATE', 'FINAL']));

  // Defect #5 — zero-padding was stripped, so F01-F03 searched for F1..F3 and failed a valid plan.
  test('preserves zero-padding (#5)', () =>
    assert.deepEqual(expandIds('F01-F03'), ['F01', 'F02', 'F03']));

  test('unpadded stays unpadded', () =>
    assert.deepEqual(expandIds('F8-F11'), ['F8', 'F9', 'F10', 'F11']));

  // Defect #6 — 'F1-U3' silently expanded to F1,F2,F3: invented F-IDs, dropped the U family.
  test('mismatched prefix errors (#6)', () =>
    assert.throws(() => expandIds('F1-U3'), (e) =>
      e instanceof PlanSpecError && /mixes prefixes/.test(e.message)));

  test('reversed range errors', () =>
    assert.throws(() => expandIds('F5-F2'), /reversed/));
});

describe('README table parsing', () => {
  test('normalizeIdSpec folds en/em dashes and markup', () => {
    assert.equal(normalizeIdSpec('`F1–F8`'), 'F1-F8');
    assert.equal(normalizeIdSpec('**U1 — U3**'), 'U1-U3');
  });

  test('parseReadmeWaveRows reads the rightmost cell, skips the header', () => {
    const rows = parseReadmeWaveRows(README('| 0 | [wave-0-a.md](wave-0-a.md) | Theme | F1-F2 |'));
    assert.deepEqual([...rows], [['wave-0-a.md', 'F1-F2']]);
  });
});

describe('end-to-end verdicts', () => {
  const good = () => build({ 0: '### Task F1 — A\n\n### Task F2 — B' });

  test('valid plan passes', () => {
    const r = run(good(), '--ids', 'F1,F2');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /VERDICT: PASS/);
  });

  // Defect #4 — omitting --ids returned PASS, silently voiding the format's core invariant.
  test('missing --ids now FAILs (#4)', () => {
    const r = run(good());
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /core invariant/);
  });

  test('--no-ids is an explicit opt-out (#4)', () => {
    const r = run(good(), '--no-ids');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /skipped by --no-ids/);
  });

  test('zero-padded backlog IDs verify (#5)', () => {
    const r = run(build({ 0: '### Task F01 — A\n\n### Task F02 — B' }), '--ids', 'F01-F02');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /2 covered/);
  });

  test('mismatched prefix range is a hard error (#6)', () => {
    const r = run(good(), '--ids', 'F1-U3');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /mixes prefixes/);
  });

  // Defect #7 — any line containing 'Create:' was skipped whole, so the compact task form
  // (Create: and Modify: merged onto one line) silently lost its Modify path check.
  test('compact form still checks Modify paths, Create: stays exempt (#7)', () => {
    const folder = build({
      0: '### Task F1 — A\n\n**Covers:** F1 (S) · depends — · ' +
        '**Create:** `src/new.ts` · **Modify:** `src/absent.ts`',
    });
    const r = run(folder, '--ids', 'F1');
    assert.match(r.out, /src\/absent\.ts/, 'Modify path should be checked');
    assert.doesNotMatch(r.out, /src\/new\.ts/, 'Create path should be exempt');
  });

  // Defect #8 — a wave file the README never lists passed silently: dropped work.
  test('orphan wave file FAILs (#8)', () => {
    const r = run(build({ 0: '### Task F1 — A', 9: '### Task Z1 — Z' }, { readmeWaves: [0] }),
      '--ids', 'F1');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /orphan wave/);
  });

  // Defect #11 — lexicographic sort put wave-10 between wave-1 and wave-2.
  test('wave files sort numerically (#11)', () => {
    const folder = build(
      { 0: '### Task F1 — A', 2: '### Task F2 — B', 10: '### Task F3 — C' },
      { readmeWaves: [] },
    );
    const r = run(folder, '--ids', 'F1,F2,F3');
    const order = [...r.out.matchAll(/(wave-\d+)-theme\.md: never referenced/g)].map((m) => m[1]);
    assert.deepEqual(order, ['wave-0', 'wave-2', 'wave-10']);
  });

  test('missing backlog ID FAILs', () => {
    const r = run(good(), '--ids', 'F1,F2,F3');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /F3/);
  });

  test('duplicate task heading FAILs', () => {
    const r = run(build({ 0: '### Task F1 — A\n\n### Task F1 — A again' }), '--ids', 'F1');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /duplicate/);
  });

  test('wave without Status tracking FAILs', () => {
    const folder = build({ 0: '### Task F1 — A' });
    const p = path.join(folder, 'wave-0-theme.md');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('## Status tracking', '## Progress'));
    const r = run(folder, '--ids', 'F1');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Status tracking/);
  });

  test('wave without a gate FAILs', () => {
    const folder = build({ 0: '### Task F1 — A' });
    const p = path.join(folder, 'wave-0-theme.md');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
      .replace('### Task W0-GATE — Wave verification gate', ''));
    const r = run(folder, '--ids', 'F1');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no gate task/);
  });

  test('broken internal link FAILs', () => {
    const r = run(build({ 0: '### Task F1 — A\n\nSee [nope](wave-404-gone.md).' }), '--ids', 'F1');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /broken internal links/);
  });

  test('orphan design doc FAILs', () => {
    const r = run(build({ 0: '### Task F1 — A' }, { extra: { 'design-thing.md': '# Design\n' } }),
      '--ids', 'F1');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /orphan design doc/);
  });

  test('wired design doc passes', () => {
    const r = run(
      build({ 0: '### Task F1 — A\n\n**Design:** [d](design-thing.md)' },
        { extra: { 'design-thing.md': '# Design\n' } }),
      '--ids', 'F1',
    );
    assert.equal(r.code, 0, r.out);
  });

  test('unwired ARCHITECTURE.md FAILs', () => {
    const r = run(build({ 0: '### Task F1 — A' }, { extra: { 'ARCHITECTURE.md': '# Arch\n' } }),
      '--ids', 'F1');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /unwired/);
  });
});

describe('--ids-from-readme (backlog-drift detection)', () => {
  test('derives IDs and passes when in sync', () => {
    const folder = build(
      { 0: '### Task F1 — A\n\n### Task F2 — B', 1: '### Task U1 — C' },
      { rowsFor: { 0: 'F1-F2', 1: 'U1' } },
    );
    const r = run(folder, '--ids-from-readme');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /derived 3 from README/);
  });

  test('handles en-dash ranges as a real README table would', () => {
    const folder = build(
      { 0: '### Task F1 — A\n\n### Task F2 — B' },
      { rowsFor: { 0: 'F1–F2' } },
    );
    const r = run(folder, '--ids-from-readme');
    assert.equal(r.code, 0, r.out);
  });

  test('catches a row attributed to the wrong wave', () => {
    const folder = build(
      { 0: '### Task F1 — A', 1: '### Task U1 — C\n\n### Task F2 — B' },
      { rowsFor: { 0: 'F1-F2', 1: 'U1' } },
    );
    const r = run(folder, '--ids-from-readme');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /has drifted/);
  });
});
