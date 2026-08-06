#!/usr/bin/env node
/**
 * Verify a multi-wave plan folder (writing-wave-plans skill, Step 4).
 *
 * Usage:
 *   node verify-plan.mjs <plan-folder> --ids "F1-F8,U1-U11,E1-E2,Q1-Q7" [--root <repo-root>]
 *
 * Checks (FAIL -> exit 1):
 *   - README.md + at least one wave-*.md exist
 *   - --ids was supplied (backlog-ID traceability is this format's core invariant; a plan with no
 *     backlog source must say so explicitly with --no-ids rather than skipping the check silently)
 *   - every backlog ID has exactly one `### Task <ID> —` heading (none missing, none duplicated)
 *   - with --ids-from-readme: IDs are derived from the README wave-files table, and each wave file
 *     must actually hold the rows that table attributes to it (catches a table drifted out of sync
 *     with its own waves after a mid-effort backlog change)
 *   - every internal .md link resolves within the folder
 *   - every wave file has a `## Status tracking` section and a `Status:` line
 *   - every wave file has a gate task (`Task W<N>-GATE` / `Task <X>-GATE` / `Task FINAL`)
 *   - every wave-*.md is referenced by README.md — an unlisted wave file is work that silently
 *     drops out of the plan
 *   - README has a wave-rollup status section
 *   - if ARCHITECTURE.md exists, README references it (links/paths in ALL *.md are scanned)
 *   - every design*.md is linked from some non-design plan file (README/wave/ARCHITECTURE),
 *     directly or transitively via its design spine — a self-referential design cluster FAILs
 *
 * Warnings (reported, exit 0 unless --strict):
 *   - referenced repo *files* (a backticked path with an extension) that don't exist.
 *     Skipped: globs, `Create:` clauses, branch/domain names, and extension-less tokens that
 *     don't resolve on disk (import paths like `database/sql`, to-be-created dirs) — so the
 *     check stays quiet on backend/CLI/library plans, not just frontend ones.
 *   - package scripts the plan invokes in code spans/fences (`yarn x` / `npm run x` / `pnpm x`)
 *     that the repo-root package.json does not define — a gate must not demand tooling the repo
 *     lacks (write its degraded form instead). Skipped when no root package.json exists;
 *     package-manager builtins (install, add, dlx, ...) are ignored.
 *
 * IDs: comma-separated tokens; `F1-F8` expands to F1..F8; bare tokens pass through.
 * Zero-padding is preserved (`F01-F03` -> F01, F02, F03) because spreadsheet backlogs pad row IDs.
 * A range whose two ends disagree on prefix (`F1-U3`) is an error, not a silent F1..F3.
 * --root defaults to the nearest ancestor of the plan folder containing `.git`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/** Thrown for a malformed --ids spec; main() turns it into `FAIL: …` + exit 1. */
export class PlanSpecError extends Error {}

const RANGE_RE = /^([A-Za-z]+)(\d+)-([A-Za-z]*)(\d+)$/;

export function expandIds(spec) {
  const ids = [];
  for (const token of spec.split(',').map((t) => t.trim()).filter(Boolean)) {
    const m = RANGE_RE.exec(token);
    if (!m) {
      ids.push(token);
      continue;
    }
    const [, prefix, loRaw, hiPrefix, hiRaw] = m;
    if (hiPrefix && hiPrefix !== prefix) {
      throw new PlanSpecError(
        `--ids range '${token}' mixes prefixes '${prefix}' and '${hiPrefix}' — ` +
          'a range must share one prefix; list the two families separately',
      );
    }
    const lo = Number(loRaw);
    const hi = Number(hiRaw);
    if (hi < lo) {
      throw new PlanSpecError(`--ids range '${token}' is reversed/empty (expands to no IDs)`);
    }
    // Preserve zero-padding: a backlog whose rows are F01..F08 must not be looked up as
    // F1..F08, which would report every row missing.
    const pad = loRaw.startsWith('0') && loRaw.length === hiRaw.length ? loRaw.length : 0;
    for (let i = lo; i <= hi; i++) {
      ids.push(`${prefix}${pad ? String(i).padStart(pad, '0') : i}`);
    }
  }
  return ids;
}

/** Trim any of `chars` from both ends (Python's str.strip(chars)). */
function trimChars(s, chars) {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

const WAVE_LINK_RE = /\((wave-[^)#\s]+\.md)\)/;

/**
 * Map wave filename -> backlog-rows cell, from the README wave-files table.
 * Tolerant of column count: any table row linking a `wave-*.md` contributes, and the LAST cell
 * is taken as its backlog rows (the template's rightmost column).
 */
export function parseReadmeWaveRows(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped.startsWith('|')) continue;
    const cells = trimChars(stripped, '|').split('|').map((c) => c.trim());
    let link = null;
    for (const c of cells) {
      const m = WAVE_LINK_RE.exec(c);
      if (m) {
        link = m[1];
        break;
      }
    }
    if (!link) continue;
    const rows = trimChars(cells[cells.length - 1], '`* ');
    if (rows && !['-', '—', '–'].includes(rows) && !['backlog rows', 'rows'].includes(rows.toLowerCase())) {
      out.set(link, rows);
    }
  }
  return out;
}

/** README cells use en/em dashes for ranges and may carry markup; --ids uses plain hyphens. */
export function normalizeIdSpec(spec) {
  return spec.replace(/–/g, '-').replace(/—/g, '-').replace(/[\s`*]+/g, '');
}

function findRoot(start) {
  let cur = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(start);
    cur = parent;
  }
}

export function braceExpand(p) {
  const m = /\{([^}]*)\}/.exec(p);
  if (!m) return [p];
  const pre = p.slice(0, m.index);
  const post = p.slice(m.index + m[0].length);
  return m[1].split(',').flatMap((part) => braceExpand(pre + part + post));
}

const PATH_RE = /`([A-Za-z0-9_.-]+\/[A-Za-z0-9_./{},*-]+)`/g;
const LINK_RE = /\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g;
const TASK_RE = /^### Task ([A-Za-z0-9-]+) —/gm;
const GATE_RE = /^### Task (?:[A-Za-z0-9]+-GATE|FINAL)\b/m;
const STATUS_LINE_RE = /^Status:/m;
const WAVE_NUM_RE = /^wave-(\d+)/;
// Paths introduced by `Create:` don't exist yet, so they must not be warned about — but drop only
// THAT CLAUSE, never the whole line: the compact task form (blessed by SKILL.md) puts `Create:` and
// `Modify:` on one line, and skipping the line would silently disable the Modify path check.
const CREATE_CLAUSE_RE = /\*{0,2}Create:\*{0,2}.*?(?=·|\*{0,2}Modify:|$)/g;

// Package-script check: only text inside inline code spans / fenced blocks is scanned
// (prose like "we use yarn for installs" must not trip it).
const CODE_SPAN_RE = /`([^`\n]+)`/g;
const FENCE_RE = /```[^\n]*\n([\s\S]*?)```/g;
const SCRIPT_CMD_RE = /\b(yarn|pnpm|npm)(\s+run)?\s+([A-Za-z][A-Za-z0-9:._-]*)/g;
const PM_BUILTINS = {
  yarn: new Set([
    'install', 'add', 'remove', 'upgrade', 'upgrade-interactive', 'up', 'dlx', 'exec',
    'init', 'link', 'unlink', 'node', 'why', 'workspace', 'workspaces', 'cache', 'config',
    'dedupe', 'info', 'pack', 'patch', 'patch-commit', 'plugin', 'rebuild', 'set',
    'version', 'bin', 'create', 'audit', 'global', 'list', 'licenses', 'outdated',
    'publish', 'tag', 'team', 'policies', 'import', 'check', 'help', 'login', 'logout',
    'unplug', 'stage', 'autoclean', 'constraints', 'explain', 'search',
  ]),
  pnpm: new Set([
    'install', 'i', 'add', 'remove', 'rm', 'update', 'up', 'dlx', 'exec', 'init', 'link',
    'unlink', 'why', 'config', 'audit', 'list', 'ls', 'outdated', 'publish', 'patch',
    'patch-commit', 'store', 'create', 'setup', 'import', 'rebuild', 'prune', 'fetch',
    'deploy', 'root', 'bin', 'env', 'help', 'pack', 'licenses', 'server',
  ]),
};
const NPM_BARE_SCRIPT_CMDS = new Set(['test', 'start', 'stop', 'restart']); // run scripts without `run`
const NON_PATH_FIRST_SEG = new Set(['feature', 'release', 'hotfix', 'bugfix', 'origin', 'refs']);

const USAGE = 'Usage: node verify-plan.mjs <plan-folder> --ids "F1-F8,U1-U11" [--ids-from-readme] [--no-ids] [--root <dir>] [--strict]';

export function run(argv) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        ids: { type: 'string', default: '' },
        'no-ids': { type: 'boolean', default: false },
        'ids-from-readme': { type: 'boolean', default: false },
        root: { type: 'string' },
        strict: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    console.error(`FAIL: ${e.message}\n${USAGE}`);
    return 1;
  }
  if (values.help || positionals.length !== 1) {
    console.error(USAGE);
    return values.help ? 0 : 1;
  }

  const folder = path.resolve(positionals[0]);
  const root = path.resolve(values.root ?? findRoot(folder));
  const failures = [];
  const warnings = [];

  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    console.log(`FAIL: plan folder not found: ${folder}`);
    return 1;
  }

  const entries = fs.readdirSync(folder).filter((n) => n.endsWith('.md'));
  const readmeName = 'README.md';
  const waveNames = entries
    .filter((n) => /^wave-.*\.md$/.test(n))
    // Natural sort: a plain lexicographic sort puts wave-10 between wave-1 and wave-2.
    .sort((a, b) => {
      const na = WAVE_NUM_RE.exec(a);
      const nb = WAVE_NUM_RE.exec(b);
      const va = na ? Number(na[1]) : Number.MAX_SAFE_INTEGER;
      const vb = nb ? Number(nb[1]) : Number.MAX_SAFE_INTEGER;
      return va - vb || a.localeCompare(b);
    });

  if (!entries.includes(readmeName)) failures.push('README.md missing');
  if (waveNames.length === 0) failures.push('no wave-*.md files found');
  if (failures.length) {
    console.log(failures.map((f) => `FAIL: ${f}`).join('\n'));
    return 1;
  }

  const extraNames = entries.filter((n) => n !== readmeName && !waveNames.includes(n)).sort();
  const order = [readmeName, ...waveNames, ...extraNames];
  const texts = new Map(
    order.map((n) => [n, fs.readFileSync(path.join(folder, n), 'utf8')]),
  );
  const allText = order.map((n) => texts.get(n)).join('');
  const readmeText = texts.get(readmeName);

  console.log(
    `root: ${root}` +
      (fs.existsSync(path.join(root, '.git'))
        ? ''
        : '  (no .git found — path checks may be noisy; pass --root)'),
  );

  // 1. Backlog-ID coverage (exactly one task heading per ID)
  const readmeRows = parseReadmeWaveRows(readmeText);
  let ids = expandIds(values.ids);
  if (values['ids-from-readme']) {
    if (readmeRows.size === 0) {
      failures.push(
        '--ids-from-readme: no wave rows parsed from the README wave-files table ' +
          '(expected rows linking wave-*.md with a backlog-rows column)',
      );
    }
    const derived = [...readmeRows.values()].flatMap((spec) => expandIds(normalizeIdSpec(spec)));
    ids = [...new Set([...ids, ...derived])]; // union, order-preserving
    console.log(`ids: derived ${derived.length} from README wave table (${readmeRows.size} wave row(s))`);
  }
  if (ids.length === 0) {
    if (values['no-ids']) {
      warnings.push('backlog coverage skipped by --no-ids');
    } else {
      failures.push(
        'no --ids provided — backlog-ID traceability is this format\'s core invariant and ' +
          'was NOT checked. Pass --ids "F1-F8,U1-U11,..." (or --no-ids if this plan genuinely ' +
          'has no backlog source)',
      );
    }
  }
  const headings = [...allText.matchAll(TASK_RE)].map((m) => m[1]);
  const counts = new Map();
  for (const h of headings) counts.set(h, (counts.get(h) ?? 0) + 1);
  const missing = ids.filter((i) => !counts.has(i));
  const dupes = ids.filter((i) => (counts.get(i) ?? 0) > 1);
  if (missing.length) failures.push(`backlog IDs with no 'Task <ID> —' heading: ${missing.join(', ')}`);
  if (dupes.length) failures.push(`backlog IDs with duplicate task headings: ${dupes.join(', ')}`);
  console.log(
    `ids: ${ids.length} requested, ${ids.length - missing.length} covered, ` +
      `dupes: ${dupes.length ? dupes.join(', ') : 'none'}`,
  );

  // 1b. Drift: the README table must attribute each row to the wave file that actually holds it.
  // (An ID missing everywhere is already reported above — here we only flag MISATTRIBUTION.)
  if (values['ids-from-readme']) {
    for (const [fname, spec] of readmeRows) {
      if (!texts.has(fname)) continue; // missing/unlinked wave files: link + orphan checks cover it
      const held = new Set([...texts.get(fname).matchAll(TASK_RE)].map((m) => m[1]));
      for (const i of expandIds(normalizeIdSpec(spec))) {
        if (!held.has(i) && (counts.get(i) ?? 0) > 0) {
          failures.push(
            `README attributes ${i} to ${fname}, but that row's task heading lives in ` +
              'another wave file (README wave table has drifted — reconcile it)',
          );
        }
      }
    }
  }

  // 2. Internal links resolve
  const broken = [
    ...new Set(
      [...texts.values()]
        .flatMap((t) => [...t.matchAll(LINK_RE)].map((m) => m[1]))
        .filter((t) => !t.startsWith('http') && !fs.existsSync(path.join(folder, t))),
    ),
  ].sort();
  if (broken.length) failures.push(`broken internal links: ${broken.join(', ')}`);
  console.log(`links: ${broken.length ? broken.join(', ') : 'OK'}`);

  // 3. Per-wave status tracking + gates; README rollup
  const failuresBeforeWaves = failures.length;
  for (const name of waveNames) {
    const text = texts.get(name);
    if (!text.includes('## Status tracking')) failures.push(`${name}: no '## Status tracking' section`);
    if (!STATUS_LINE_RE.test(text)) failures.push(`${name}: no 'Status:' line`);
    if (!GATE_RE.test(text)) failures.push(`${name}: no gate task (Task <X>-GATE or Task FINAL)`);
  }
  // A wave file the README never names is work that silently drops out of the plan — the same
  // class of defect the design-doc orphan check below catches.
  for (const name of waveNames) {
    if (!readmeText.includes(name)) {
      failures.push(
        `${name}: never referenced by README.md (orphan wave — add it to the wave-files ` +
          'table and the status rollup)',
      );
    }
  }
  if (!readmeText.includes('Status tracking')) {
    failures.push("README.md: no wave-rollup 'Status tracking' section");
  }
  if (entries.includes('ARCHITECTURE.md') && !readmeText.includes('ARCHITECTURE.md')) {
    failures.push('ARCHITECTURE.md exists but README.md never links/references it (unwired)');
  }
  const designs = entries.filter((n) => /^design.*\.md$/.test(n));
  if (designs.length) {
    const anchorText = order.filter((n) => !designs.includes(n)).map((n) => texts.get(n)).join('');
    const wired = new Set(designs.filter((d) => anchorText.includes(d)));
    for (let grew = true; grew; ) {
      grew = false;
      for (const d of designs) {
        if (wired.has(d)) continue;
        if ([...wired].some((w) => texts.get(w).includes(d))) {
          wired.add(d); // a split (design-X-components.md) is wired via its wired spine
          grew = true;
        }
      }
    }
    for (const d of designs.filter((x) => !wired.has(x)).sort()) {
      failures.push(
        `${d}: no non-design plan file links it, directly or via its spine ` +
          '(orphan design doc — link it from the wave that builds the feature)',
      );
    }
  }
  const waveIssues = failures.length - failuresBeforeWaves;
  console.log(
    `waves: ${waveNames.length} files (+${extraNames.length} extra doc(s)), ` +
      `gates+status+wiring ${waveIssues ? `${waveIssues} ISSUE(S)` : 'OK'}`,
  );

  // 4. Referenced repo paths exist (warnings)
  for (const name of order) {
    const lines = texts.get(name).split(/\r?\n/);
    for (const [idx, line] of lines.entries()) {
      const scan = line.replace(CREATE_CLAUSE_RE, ' ');
      for (const m of scan.matchAll(PATH_RE)) {
        const raw = m[1];
        const firstSeg = raw.split('/')[0];
        if (
          raw.includes('*') ||
          /^[\d/.x]+$/.test(raw) || // value notation like 8/14/16/20
          firstSeg.includes('.') || // domain names (s3-cdn.example.com/...)
          NON_PATH_FIRST_SEG.has(firstSeg) // branch/ref names
        ) {
          continue;
        }
        for (const cand of braceExpand(raw)) {
          const clean = cand.replace(/\/+$/, '');
          if (fs.existsSync(path.join(root, clean))) continue;
          // Only flag a missing token that looks like a FILE (has an extension in its last
          // segment). Extension-less non-resolving tokens are language import paths
          // (database/sql, net/http), to-be-created dirs, or prose — not file typos.
          if (!clean.split('/').pop().includes('.')) continue;
          warnings.push(`${name}:${idx + 1} references missing path \`${cand}\``);
        }
      }
    }
  }
  console.log(`paths: ${warnings.length} warning(s)${warnings.length ? ' (see below)' : ''}`);

  // 5. Package scripts the plan invokes actually exist (warnings)
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.log('scripts: skipped (no package.json at root)');
  } else {
    let scripts = null;
    try {
      scripts = new Set(Object.keys(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts ?? {}));
    } catch (e) {
      console.log(`scripts: skipped (package.json unreadable: ${e.message})`);
    }
    if (scripts) {
      const hits = new Map();
      for (const text of texts.values()) {
        const code =
          [...text.matchAll(CODE_SPAN_RE)].map((m) => m[1]).join('\n') +
          '\n' +
          [...text.matchAll(FENCE_RE)].map((m) => m[1]).join('\n');
        for (const [, tool, ran, word] of code.matchAll(SCRIPT_CMD_RE)) {
          if (tool === 'npm') {
            // bare npm subcommands other than test/start/... are builtins
            if (!ran && !NPM_BARE_SCRIPT_CMDS.has(word)) continue;
          } else if (!ran && PM_BUILTINS[tool].has(word)) {
            continue;
          }
          if (!scripts.has(word)) {
            const key = `${tool} ${word}`;
            hits.set(key, (hits.get(key) ?? 0) + 1);
          }
        }
      }
      for (const [key, n] of [...hits.entries()].sort()) {
        const [tool, word] = key.split(' ');
        const runPart = tool === 'npm' ? ' run' : '';
        warnings.push(
          `plan invokes \`${tool}${runPart} ${word}\` (${n}x) but package.json defines no script ` +
            `'${word}' — a gate must not demand tooling the repo lacks; write its degraded form`,
        );
      }
      console.log(`scripts: ${hits.size} undefined-script warning(s)`);
    }
  }

  for (const w of warnings) console.log(`WARN: ${w}`);
  for (const f of failures) console.log(`FAIL: ${f}`);
  const ok = failures.length === 0 && !(values.strict && warnings.length);
  console.log(`VERDICT: ${ok ? 'PASS' : 'FAIL'}`);
  return ok ? 0 : 1;
}

function main() {
  try {
    return run(process.argv.slice(2));
  } catch (e) {
    if (e instanceof PlanSpecError) {
      console.error(`FAIL: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
