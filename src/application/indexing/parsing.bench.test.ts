/**
 * B4 — Benchmark-driven tuning loop for Phase 2 parsing.
 *
 * This is the REAL-parse counterpart to {@link ingestion.bench.test.ts} (which
 * mocks out `extractAllSymbols`, leaving the parse path unbenched). It generates
 * a LARGE synthetic on-disk source tree with REAL TypeScript content — so
 * tree-sitter actually parses it — then runs the REAL {@link extractAllSymbols}
 * across a sweep of thread counts and reports throughput + peak RSS per config.
 *
 * Crucially it ALSO doubles as B1's at-scale correctness gate: it ASSERTS that
 * the symbol/hint output is BYTE-IDENTICAL across every thread count. Parallel
 * parsing is only legitimate if completion order never leaks into the result.
 *
 * Thread sweep mechanics:
 *   - When the compiled worker entry (`dist/.../parse-worker.js`) exists, the
 *     sweep drives the REAL `worker_threads` pool at each thread count.
 *   - Under a plain `vitest run` (no build) a `.ts` worker entry cannot be loaded
 *     natively (Node 20, no TS loader), so the sweep falls back to the in-process
 *     async pool, varying its `concurrency`. Either way the slot/flatten/dedup
 *     tail is identical, so the byte-identical assertion holds.
 *
 * Output: symbols/sec, files/sec, wall ms, and peakRssBytes per config — ALL to
 * process.stderr only (privacy rule: never stdout, never source/symbol text).
 *
 * Env knobs:
 *   - BENCH_FILES        synthetic file count (default 800).
 *   - BENCH_FILE_BYTES   approximate bytes of real .ts content per file (default 2048).
 *   - BENCH_THREAD_SWEEP comma list of thread counts, e.g. "1,6,11,12" (default "1,2,4,8").
 *
 * GATING: the heavy body is `describe.skip` UNLESS `RUN_BENCH` is set, so a
 * normal `vitest run` discovers but does NOT execute it. Run on demand via the
 * `bench:parse` package script (sets RUN_BENCH=1). The FAST, always-on smoke that
 * exercises the worker code path on CI lives in `indexer-performance.test.ts`.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractAllSymbols } from "./parsing/index.js";
import type { FileNode } from "./structure/index.js";

// ─── Env helpers ────────────────────────────────────────────────────────────

/** Read a positive-integer env var, falling back to a default. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received ${raw}`);
  }
  return parsed;
}

/** Parse a comma-separated thread sweep, e.g. "1,6,11,12". */
function envThreadSweep(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`${name} entries must be positive integers, received "${s}"`);
      }
      return n;
    });
  if (parsed.length === 0) throw new Error(`${name} must contain at least one thread count`);
  return parsed;
}

// ─── Synthetic real-TypeScript file generator ───────────────────────────────

/**
 * Emit REAL, parseable TypeScript for one file, padded to ~`targetBytes`. Each
 * file declares an interface, a class with a method, and several functions that
 * call one another and import from a sibling — so tree-sitter produces a healthy
 * mix of symbols AND relationship hints (calls/imports). Content is fully
 * deterministic in `i` so the corpus is reproducible run-to-run.
 */
function generateTsFile(i: number, fileCount: number, targetBytes: number): string {
  const sibling = (i + 1) % fileCount;
  const header = [
    `import { helper${sibling} } from "./mod${sibling}.js";`,
    ``,
    `export interface Shape${i} {`,
    `  readonly id: number;`,
    `  readonly label: string;`,
    `}`,
    ``,
    `export class Widget${i} {`,
    `  constructor(private readonly seed: number) {}`,
    `  compute(y: number): number {`,
    `    return this.seed + helper${sibling}(y);`,
    `  }`,
    `}`,
    ``,
    `export function helper${i}(v: number): number {`,
    `  return v * ${i + 1} + 1;`,
    `}`,
    ``,
  ];

  const lines = [...header];
  // Pad with additional REAL functions (each is a distinct symbol with a CALLS
  // hint into the previous one) until we cross the target byte budget.
  let bytes = lines.join("\n").length;
  let fn = 0;
  while (bytes < targetBytes) {
    const prev = fn === 0 ? `helper${i}` : `pad${i}_${fn - 1}`;
    const block = [
      `export function pad${i}_${fn}(n: number): number {`,
      `  const base = ${prev}(n);`,
      `  return base + n * ${fn + 2};`,
      `}`,
      ``,
    ];
    lines.push(...block);
    bytes += block.join("\n").length;
    fn++;
  }
  return lines.join("\n");
}

// ─── Reporting (stderr only — never stdout, never source/symbol text) ─────────

interface SweepRun {
  readonly threads: number;
  readonly wallMs: number;
  readonly symbols: number;
  readonly hints: number;
  readonly files: number;
  readonly skipped: number;
  readonly peakRssBytes: number;
}

function reportRun(run: SweepRun): void {
  const symbolsPerSec = run.wallMs > 0 ? (run.symbols / run.wallMs) * 1000 : 0;
  const filesPerSec = run.wallMs > 0 ? (run.files / run.wallMs) * 1000 : 0;
  process.stderr.write(
    `[bench:parse] threads=${String(run.threads).padStart(2)} ` +
      `wall=${run.wallMs.toFixed(1).padStart(8)}ms ` +
      `symbols/sec=${symbolsPerSec.toFixed(0).padStart(8)} ` +
      `files/sec=${filesPerSec.toFixed(1).padStart(7)} ` +
      `peakRss=${(run.peakRssBytes / (1024 * 1024)).toFixed(1).padStart(7)}MB ` +
      `(${run.symbols} symbols, ${run.hints} hints, ${run.skipped} skipped)\n`,
  );
}

// ─── Harness body (gated) ─────────────────────────────────────────────────────

const BENCH_ENABLED = process.env.RUN_BENCH !== undefined && process.env.RUN_BENCH !== "";
const runner = BENCH_ENABLED ? describe : describe.skip;

runner("Phase 2 parsing benchmark + cross-thread determinism gate", () => {
  let dir: string;
  let fileNodes: FileNode[];
  let useRealWorkers: boolean;

  beforeAll(async () => {
    const fileCount = envInt("BENCH_FILES", 800);
    const fileBytes = envInt("BENCH_FILE_BYTES", 2048);

    dir = await mkdtemp(path.join(os.tmpdir(), "typocop-parse-bench-"));
    const nodes: FileNode[] = [];
    for (let i = 0; i < fileCount; i++) {
      const rel = `mod${i}.ts`;
      const abs = path.join(dir, rel);
      await writeFile(abs, generateTsFile(i, fileCount, fileBytes), "utf-8");
      const st = await stat(abs);
      nodes.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs, language: "typescript" });
    }
    fileNodes = nodes;

    // Prefer the REAL worker_threads pool when the compiled entry exists (i.e.
    // after `pnpm build`); otherwise sweep the in-process async pool concurrency.
    const distWorker = path.resolve(
      process.cwd(),
      "dist/infrastructure/parsing/parse-worker.js",
    );
    useRealWorkers = existsSync(distWorker);

    process.stderr.write(
      `\n[bench:parse] corpus: ${fileCount} files, ~${fileBytes} bytes each, ` +
        `path=${useRealWorkers ? "worker_threads (real)" : "in-process async pool"}\n`,
    );
  }, 120_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it(
    "throughput sweep + byte-identical symbols/hints across all thread counts",
    async () => {
      const sweep = envThreadSweep("BENCH_THREAD_SWEEP", [1, 2, 4, 8]);

      // Baseline reference: a single serial in-process run. Every sweep config
      // must reproduce its symbols/hints byte-for-byte (B1 correctness gate).
      const reference = await extractAllSymbols(fileNodes, dir, { useWorkerThreads: false });
      const referenceJson = JSON.stringify({
        symbols: reference.symbols,
        hints: reference.hints,
        skippedFiles: reference.skippedFiles,
      });

      for (const threads of sweep) {
        // Force the parallel path on (threshold 1) so even a 1-thread sweep entry
        // exercises the pool dispatch. Map the swept "threads" onto BOTH the
        // worker count and the in-process concurrency so both fallbacks honour it.
        const start = performance.now();
        const result = await extractAllSymbols(fileNodes, dir, {
          useWorkerThreads: useRealWorkers,
          workerThreshold: 1,
          parseThreads: threads,
          concurrency: threads,
        });
        const wallMs = performance.now() - start;

        // Determinism gate: byte-identical to the serial reference.
        const runJson = JSON.stringify({
          symbols: result.symbols,
          hints: result.hints,
          skippedFiles: result.skippedFiles,
        });
        expect(runJson, `thread count ${threads} output diverged from serial`).toBe(
          referenceJson,
        );

        reportRun({
          threads,
          wallMs,
          symbols: result.symbols.length,
          hints: result.hints.length,
          files: fileNodes.length,
          skipped: result.skippedFiles,
          peakRssBytes: process.memoryUsage().rss,
        });
      }

      expect(reference.symbols.length).toBeGreaterThan(0);
    },
    600_000,
  );
});
