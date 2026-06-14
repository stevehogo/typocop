/**
 * Unit tests for the B6 progress renderer.
 *
 * Covers: throttled TTY redraws, final 100% frame, line clearing, all writes to
 * the injected stream (none to stdout), non-TTY verbose plain lines (no ANSI),
 * non-TTY non-verbose silence, counter reaching total with skipped files, and
 * that throttling produces far fewer writes than updates.
 */
import { describe, it, expect, vi } from "vitest";
import { ProgressRenderer, createProgressRenderer, TTY_THROTTLE_MS } from "./progress.js";

/** Fake stream capturing writes; isTTY configurable. */
function fakeStream(isTTY: boolean) {
  const writes: string[] = [];
  return {
    isTTY,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    writes,
  };
}

const ESC = "\x1b";
const hasAnsi = (s: string) => s.includes(ESC);

describe("ProgressRenderer — TTY mode", () => {
  it("renders to the injected stream with carriage returns and a final 100% frame, then clears", () => {
    const stream = fakeStream(true);
    // Advance the monotonic clock so throttle gates open between draws.
    let clock = 0;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const r = new ProgressRenderer({ stream });
      const total = 5;
      for (let done = 1; done <= total; done++) {
        clock += TTY_THROTTLE_MS + 1; // ensure each passes the throttle gate
        r.onProgress(done, total, `file${done}.ts`);
      }
      r.done();

      // Every write begins with a carriage return (rewound line) or is the clear.
      expect(stream.writes.length).toBeGreaterThan(0);
      const frames = stream.writes.filter((w) => w.startsWith("\r["));
      expect(frames.length).toBeGreaterThan(0);
      for (const f of frames) expect(f.startsWith("\r")).toBe(true);

      // Final 100% frame drawn before clearing.
      const last100 = frames[frames.length - 1];
      expect(last100).toContain("5/5");
      expect(last100).toContain("(100%)");

      // Line cleared on completion.
      expect(stream.writes[stream.writes.length - 1]).toContain("\x1b[2K");
    } finally {
      spy.mockRestore();
    }
  });

  it("always draws the final frame even if the throttle window has not elapsed", () => {
    const stream = fakeStream(true);
    // Clock never advances → throttle would suppress everything but first + last.
    const spy = vi.spyOn(performance, "now").mockReturnValue(1000);
    try {
      const r = new ProgressRenderer({ stream, label: "P" });
      const total = 100;
      for (let done = 1; done <= total; done++) r.onProgress(done, total);
      r.done();
      const frames = stream.writes.filter((w) => w.startsWith("\r["));
      // Far fewer writes than updates (throttled).
      expect(frames.length).toBeLessThan(total);
      // But the final 100% frame is present.
      expect(frames.some((f) => f.includes("100/100") && f.includes("(100%)"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("throttles: many rapid updates produce far fewer writes than updates", () => {
    const stream = fakeStream(true);
    let clock = 0;
    // Advance by only 1ms per update — well under the throttle window.
    const spy = vi.spyOn(performance, "now").mockImplementation(() => (clock += 1));
    try {
      const r = new ProgressRenderer({ stream });
      const total = 10_000;
      for (let done = 1; done <= total; done++) r.onProgress(done, total);
      r.done();
      const frames = stream.writes.filter((w) => w.startsWith("\r["));
      expect(frames.length).toBeLessThan(total / 10);
    } finally {
      spy.mockRestore();
    }
  });

  it("never writes ANSI to stdout — only to the injected stream", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stream = fakeStream(true);
    try {
      const r = new ProgressRenderer({ stream });
      r.onProgress(1, 2);
      r.onProgress(2, 2);
      r.done();
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stream.writes.length).toBeGreaterThan(0);
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

describe("ProgressRenderer — non-TTY mode", () => {
  it("verbose: emits plain progress lines with no ANSI escape sequences", () => {
    const stream = fakeStream(false);
    const r = createProgressRenderer({ stream, verbose: true });
    const total = 100;
    for (let done = 1; done <= total; done++) r.onProgress(done, total);
    r.done();

    expect(stream.writes.length).toBeGreaterThan(0);
    for (const w of stream.writes) {
      expect(hasAnsi(w)).toBe(false);
      expect(w).not.toContain("\r");
      expect(w.endsWith("\n")).toBe(true);
    }
    // Final line shows 100%.
    expect(stream.writes[stream.writes.length - 1]).toContain("100/100");
  });

  it("non-verbose: emits nothing at all", () => {
    const stream = fakeStream(false);
    const r = createProgressRenderer({ stream, verbose: false });
    for (let done = 1; done <= 50; done++) r.onProgress(done, 50);
    r.done();
    expect(stream.writes.length).toBe(0);
  });
});

describe("ProgressRenderer — counter correctness", () => {
  it("reaches total including a skipped-file scenario (done driven 0..total)", () => {
    const stream = fakeStream(false);
    const r = createProgressRenderer({ stream, verbose: true });
    const total = 4;
    // Simulate the loop: every file (parsed or skipped) bumps done once.
    let done = 0;
    const seen: number[] = [];
    for (let i = 0; i < total; i++) {
      done++; // skipped files still bump
      r.onProgress(done, total, `f${i}.ts`);
      seen.push(done);
    }
    r.done();
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(done).toBe(total);
    // Final plain line reflects 100%.
    expect(stream.writes[stream.writes.length - 1]).toContain("4/4");
    expect(stream.writes[stream.writes.length - 1]).toContain("(100%)");
  });
});
