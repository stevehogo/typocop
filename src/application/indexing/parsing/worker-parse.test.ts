/**
 * B1 integration tests: worker-pool parsing vs. the in-process path.
 *
 * The shipped product spawns real `worker_threads` whose entry is the compiled
 * `parse-worker.js`. Under vitest a `.ts` worker entry cannot be loaded natively
 * (no TS loader, Node 20), so these tests inject an IN-PROCESS {@link ParsePool}
 * that drives the SAME {@link runParseTask} logic the real worker uses — with
 * injected per-task delays and crash files — so determinism, order-independence,
 * crash isolation, the circuit-breaker fallback, the per-file `contentHash` map,
 * and once-per-file `onProgress` are all verified byte-for-byte without a build.
 *
 * A separate, teardown-tolerant smoke test exercises the REAL worker_threads path.
 */
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import * as fc from "fast-check";
import * as path from "node:path";
import * as os from "node:os";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { WorkerPool } from "../../../platform/utils/worker-pool.js";
import {
  extractAllSymbols,
  extractAllSymbolsWithPerFile,
  type ParsePool,
  type ParsePoolFactory,
} from "./index.js";
import { runParseTask } from "../../../infrastructure/parsing/parse-worker.js";
import type {
  ParseTask,
  ParseTaskResult,
} from "../../../infrastructure/parsing/parse-worker-protocol.js";
import type { WorkerPoolRunResult } from "../../../platform/utils/worker-pool.js";
import type { FileNode } from "../structure/index.js";
import Parser from "tree-sitter";

// ─── In-process pool seams ────────────────────────────────────────────────────

/**
 * Build a `ParsePoolFactory` that runs each task through the real
 * {@link runParseTask}. `directives(index)` injects ordering skew (a delay) and
 * crash simulation per original index, and `forceBreaker` models a pool that
 * tripped its breaker so the orchestrator's in-process fallback kicks in.
 */
function inProcessPoolFactory(
  directives: (index: number) => { delayMs?: number; crash?: boolean } = () => ({}),
  forceBreaker = false,
): ParsePoolFactory {
  return (_size: number): ParsePool => {
    const parsers = new Map<string, Parser>();
    return {
      async run(
        tasks: readonly ParseTask[],
        onSettled?: (index: number) => void,
      ): Promise<WorkerPoolRunResult<ParseTaskResult>> {
        const results: (ParseTaskResult | null)[] = new Array(tasks.length).fill(null);
        const failedIndices: number[] = [];
        // Settle in a SHUFFLED order so completion order differs from input order.
        const order = tasks.map((t) => t.index);
        const shuffled = [...order].sort((a, b) => {
          const da = directives(a).delayMs ?? 0;
          const db = directives(b).delayMs ?? 0;
          return db - da; // later-delayed settle "first"
        });
        const byIndex = new Map(tasks.map((t) => [t.index, t]));
        for (const idx of shuffled) {
          const slotPos = order.indexOf(idx);
          if (forceBreaker) {
            // A tripped breaker abandons every task → caller finishes in-process.
            failedIndices.push(idx);
            onSettled?.(idx);
            continue;
          }
          const d = directives(idx);
          if (d.crash) {
            // A crashing worker drops THIS file (skipped) but the pool survives.
            failedIndices.push(idx);
            onSettled?.(idx);
            continue;
          }
          const result = await runParseTask(byIndex.get(idx)!, parsers);
          results[slotPos] = result;
          onSettled?.(idx);
        }
        return {
          results,
          breakerTripped: forceBreaker,
          failedIndices: failedIndices.sort((a, b) => a - b),
        };
      },
      async destroy() {},
    };
  };
}

// ─── Fixture tree ─────────────────────────────────────────────────────────────

let dir: string;
let fileNodes: FileNode[];

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "b1-parse-"));
  // A handful of small but symbol-rich files across two languages.
  const files: Record<string, string> = {};
  for (let i = 0; i < 24; i++) {
    files[`mod${i}.ts`] = [
      `export interface Shape${i} { a: number; b: string; }`,
      `export class Widget${i} {`,
      `  constructor(private x: number) {}`,
      `  compute(y: number): number { return this.x + y; }`,
      `}`,
      `export function helper${i}(v: number): number { return v * ${i + 1}; }`,
      `import { other } from "./mod${(i + 1) % 24}.js";`,
      `export const used${i} = helper${i}(other);`,
    ].join("\n");
  }
  files["pyfile.py"] = [
    "class Animal:",
    "    def speak(self):",
    "        return 'noise'",
    "",
    "def make():",
    "    return Animal()",
  ].join("\n");

  const nodes: FileNode[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await writeFile(abs, content, "utf-8");
    const st = await stat(abs);
    nodes.push({
      path: rel,
      size: st.size,
      mtimeMs: st.mtimeMs,
      language: rel.endsWith(".py") ? "python" : "typescript",
    });
  }
  fileNodes = nodes;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ─── Determinism gate ─────────────────────────────────────────────────────────

describe("B1 determinism: pool output === in-process output", () => {
  it("symbols, hints and skippedFiles are byte-identical (serial vs pool)", async () => {
    const serial = await extractAllSymbols(fileNodes, dir, { useWorkerThreads: false });
    const pooled = await extractAllSymbols(fileNodes, dir, {
      workerThreshold: 1,
      poolFactory: inProcessPoolFactory(),
    });
    expect(JSON.stringify(pooled)).toBe(JSON.stringify(serial));
  });

  it("the per-file map (symbols/hints/contentHash) is byte-identical", async () => {
    const serial = await extractAllSymbolsWithPerFile(fileNodes, dir, { useWorkerThreads: false });
    const pooled = await extractAllSymbolsWithPerFile(fileNodes, dir, {
      workerThreshold: 1,
      poolFactory: inProcessPoolFactory(),
    });
    const norm = (m: Map<string, unknown>) =>
      JSON.stringify([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
    expect(norm(pooled.perFile)).toBe(norm(serial.perFile));
    // contentHash must be present and non-empty for every parsed file.
    for (const entry of pooled.perFile.values()) {
      expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("is order-independent under injected per-task completion skew", async () => {
    const serial = await extractAllSymbols(fileNodes, dir, { useWorkerThreads: false });
    // Heavy skew: each file gets a distinct, index-dependent delay.
    const pooled = await extractAllSymbols(fileNodes, dir, {
      workerThreshold: 1,
      poolFactory: inProcessPoolFactory((i) => ({ delayMs: (i * 7) % 13 })),
    });
    expect(JSON.stringify(pooled)).toBe(JSON.stringify(serial));
  });
});

// ─── Crash isolation ──────────────────────────────────────────────────────────

describe("B1 crash isolation", () => {
  it("a worker crash on one file does NOT abort the run: that file is recovered via fallback, the rest are unaffected, pool survives", async () => {
    // Model a worker that segfaults mid-file. The pool reports that index as
    // failed; the orchestrator finishes it on the in-process path (strictly
    // safer than dropping it), so the FULL set still matches serial.
    const serial = await extractAllSymbols(fileNodes, dir, { useWorkerThreads: false });
    const pooled = await extractAllSymbols(fileNodes, dir, {
      workerThreshold: 1,
      poolFactory: inProcessPoolFactory((i) => ({ crash: i === 7 || i === 18 })),
    });
    expect(JSON.stringify(pooled)).toBe(JSON.stringify(serial));
  });

  it("a genuinely unparseable file is counted in skippedFiles (worker skip, NOT a crash) — pool produces the rest", async () => {
    // A file the worker reads but cannot parse → runParseTask returns a skip,
    // which is NOT in failedIndices, so it is never reparsed and stays skipped.
    // Use an oversized file so parseSourceFile throws ParseError in BOTH paths.
    const big = "huge.ts";
    const bigAbs = path.join(dir, big);
    await writeFile(bigAbs, "// x\n".repeat(200_000), "utf-8"); // > MAX_FILE_SIZE
    const st = await stat(bigAbs);
    const withBig: FileNode[] = [
      ...fileNodes,
      { path: big, size: st.size, mtimeMs: st.mtimeMs, language: "typescript" },
    ];
    try {
      const serial = await extractAllSymbols(withBig, dir, { useWorkerThreads: false });
      const pooled = await extractAllSymbols(withBig, dir, {
        workerThreshold: 1,
        poolFactory: inProcessPoolFactory(),
      });
      expect(pooled.skippedFiles).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(pooled)).toBe(JSON.stringify(serial));
    } finally {
      await rm(bigAbs, { force: true });
    }
  });
});

// ─── Circuit-breaker fallback ─────────────────────────────────────────────────

describe("B1 circuit breaker → in-process fallback", () => {
  it("a tripped breaker still produces the FULL symbol set via fallback", async () => {
    const serial = await extractAllSymbols(fileNodes, dir, { useWorkerThreads: false });
    const pooled = await extractAllSymbols(fileNodes, dir, {
      workerThreshold: 1,
      poolFactory: inProcessPoolFactory(() => ({}), /* forceBreaker */ true),
    });
    // Indexing never aborts: the in-process fallback finished every abandoned file.
    expect(JSON.stringify(pooled)).toBe(JSON.stringify(serial));
  });
});

// ─── Progress contract ────────────────────────────────────────────────────────

// ─── Property: random subsets, parallel === serial ───────────────────────────

describe("B1 property: random file subsets parallel === serial", () => {
  it("any subset/order produces identical output via the pool", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.nat({ max: 24 }), { minLength: 0, maxLength: 25 }),
        fc.array(fc.integer({ min: 0, max: 12 }), { minLength: 25, maxLength: 25 }),
        async (indices, delays) => {
          const subset = indices.map((i) => fileNodes[i]).filter(Boolean);
          const serial = await extractAllSymbols(subset, dir, { useWorkerThreads: false });
          const pooled = await extractAllSymbols(subset, dir, {
            workerThreshold: 1,
            poolFactory: inProcessPoolFactory((i) => ({ delayMs: delays[i % delays.length] })),
          });
          return JSON.stringify(pooled) === JSON.stringify(serial);
        },
      ),
      { numRuns: 40 },
    );
  });
});

// ─── Real worker_threads smoke (teardown-tolerant) ────────────────────────────

describe("B1 real worker_threads smoke", () => {
  // The shipped worker entry is the COMPILED parse-worker.js; a .ts entry cannot
  // be loaded under vitest (Node 20, no TS loader). Run this only when a build
  // exists. The native tree-sitter stack can crash on worker teardown (known
  // environment noise) — we assert the RESULT, then best-effort destroy.
  const distWorker = path.resolve(
    process.cwd(),
    "dist/infrastructure/parsing/parse-worker.js",
  );
  const distAvailable = existsSync(distWorker);

  it.runIf(distAvailable)(
    "real workers parse a file and post back plain symbols",
    async () => {
      const pool = new WorkerPool({
        size: 2,
        workerEntry: distWorker,
        execArgv: process.execArgv,
        taskTimeoutMs: 20_000,
      });
      try {
        const tasks = [0, 1, 2].map((index) => ({
          index,
          filePath: path.join(dir, fileNodes[index].path),
          relativePath: fileNodes[index].path,
          language: fileNodes[index].language,
          size: fileNodes[index].size,
        }));
        const out = await pool.run(tasks as never);
        expect(out.breakerTripped).toBe(false);
        expect(out.failedIndices).toEqual([]);
        // Each result echoes its index and carries plain symbols + a contentHash.
        for (let i = 0; i < tasks.length; i++) {
          const r = out.results[i] as { index: number; symbols?: unknown[]; contentHash?: string };
          expect(r.index).toBe(i);
          expect(Array.isArray(r.symbols)).toBe(true);
          expect(typeof r.contentHash).toBe("string");
        }
      } finally {
        await pool.destroy().catch(() => undefined);
      }
    },
  );
});

describe("B1 onProgress contract", () => {
  it("fires exactly `total` times on the pool path (incl. breaker fallback)", async () => {
    for (const factory of [
      inProcessPoolFactory(),
      inProcessPoolFactory((i) => ({ crash: i % 5 === 0 })),
      inProcessPoolFactory(() => ({}), true),
    ]) {
      let fired = 0;
      let lastDone = 0;
      await extractAllSymbols(fileNodes, dir, {
        workerThreshold: 1,
        poolFactory: factory,
        onProgress: (done, total) => {
          fired++;
          lastDone = done;
          expect(total).toBe(fileNodes.length);
        },
      });
      expect(fired).toBe(fileNodes.length);
      expect(lastDone).toBe(fileNodes.length);
    }
  });
});
