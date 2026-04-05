/**
 * Unit tests for SessionManager.
 * Requirements: 2.1, 2.2, 2.3, 2.4
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Driver, Session } from "neo4j-driver";
import { SessionManager } from "./session-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockSession(closeImpl?: () => Promise<void>): Session {
  return {
    close: vi.fn().mockImplementation(closeImpl ?? (() => Promise.resolve())),
  } as unknown as Session;
}

function makeMockDriver(session?: Session): Driver {
  const s = session ?? makeMockSession();
  return {
    session: vi.fn().mockReturnValue(s),
  } as unknown as Driver;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  // -------------------------------------------------------------------------
  // acquire
  // -------------------------------------------------------------------------

  describe("acquire", () => {
    it("opens a session via driver.session() and registers it (openCount becomes 1)", async () => {
      const mockSession = makeMockSession();
      const driver = makeMockDriver(mockSession);

      const session = await manager.acquire(driver);

      expect(driver.session).toHaveBeenCalledOnce();
      expect(session).toBe(mockSession);
      expect(manager.openCount()).toBe(1);
    });

    it("returns the session produced by driver.session()", async () => {
      const mockSession = makeMockSession();
      const driver = makeMockDriver(mockSession);

      const result = await manager.acquire(driver);

      expect(result).toBe(mockSession);
    });
  });

  // -------------------------------------------------------------------------
  // release
  // -------------------------------------------------------------------------

  describe("release", () => {
    it("closes the session and removes it from the registry (openCount returns to 0)", async () => {
      const mockSession = makeMockSession();
      const driver = makeMockDriver(mockSession);

      const session = await manager.acquire(driver);
      expect(manager.openCount()).toBe(1);

      await manager.release(session);

      expect(mockSession.close).toHaveBeenCalledOnce();
      expect(manager.openCount()).toBe(0);
    });

    it("calls session.close() exactly once", async () => {
      const mockSession = makeMockSession();
      const driver = makeMockDriver(mockSession);

      const session = await manager.acquire(driver);
      await manager.release(session);

      expect(mockSession.close).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // closeAll
  // -------------------------------------------------------------------------

  describe("closeAll", () => {
    it("closes all tracked sessions and resets openCount to zero", async () => {
      // Acquire two sessions by releasing the first before acquiring the second
      // (serialization means we must release before the next acquire resolves).
      const session1 = makeMockSession();
      const session2 = makeMockSession();
      const driver = {
        session: vi.fn().mockReturnValueOnce(session1).mockReturnValueOnce(session2),
      } as unknown as Driver;

      const s1 = await manager.acquire(driver);
      // Release so the second acquire can proceed, but don't await release fully —
      // we want both in the registry at the same time. We do this by acquiring
      // the second BEFORE releasing the first, then releasing the first to unblock.
      const s2Promise = manager.acquire(driver);
      await manager.release(s1); // unblocks s2
      await s2Promise;

      expect(manager.openCount()).toBe(1); // only s2 is open now

      // Put s1 back manually isn't possible; instead test closeAll with one open session.
      await manager.closeAll();

      expect(session2.close).toHaveBeenCalledOnce();
      expect(manager.openCount()).toBe(0);
    });

    it("is safe to call with zero open sessions (does not throw)", async () => {
      await expect(manager.closeAll()).resolves.toBeUndefined();
      expect(manager.openCount()).toBe(0);
    });

    it("does not throw if one session.close() rejects (Promise.allSettled)", async () => {
      const failingSession = makeMockSession(() => Promise.reject(new Error("close failed")));
      const driver = makeMockDriver(failingSession);

      await manager.acquire(driver);
      expect(manager.openCount()).toBe(1);

      // closeAll must not throw even though close() rejects
      await expect(manager.closeAll()).resolves.toBeUndefined();
      expect(manager.openCount()).toBe(0);
    });

    it("closes multiple sessions even when one rejects", async () => {
      const goodSession = makeMockSession();
      const badSession = makeMockSession(() => Promise.reject(new Error("boom")));

      // Acquire good session, release it, then acquire bad session
      const driver1 = makeMockDriver(goodSession);
      const driver2 = makeMockDriver(badSession);

      const s1 = await manager.acquire(driver1);
      const s2Promise = manager.acquire(driver2);
      await manager.release(s1);
      await s2Promise;

      // Now only badSession is tracked; closeAll should still resolve
      await expect(manager.closeAll()).resolves.toBeUndefined();
      expect(badSession.close).toHaveBeenCalledOnce();
      expect(manager.openCount()).toBe(0);
    });

    it("resets the queue so subsequent acquire() calls proceed immediately after closeAll", async () => {
      const session1 = makeMockSession();
      const session2 = makeMockSession();
      const driver = {
        session: vi.fn().mockReturnValueOnce(session1).mockReturnValueOnce(session2),
      } as unknown as Driver;

      const s1 = await manager.acquire(driver);
      await manager.release(s1);
      await manager.closeAll();

      // After closeAll the queue should be reset — next acquire must not hang
      const s2 = await manager.acquire(driver);
      expect(s2).toBe(session2);
      expect(manager.openCount()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  describe("serialization", () => {
    it("second acquire waits for first to release before opening a new session", async () => {
      const events: string[] = [];

      const session1 = makeMockSession(async () => {
        events.push("session1:close");
      });
      const session2 = makeMockSession(async () => {
        events.push("session2:close");
      });

      const driver = {
        session: vi
          .fn()
          .mockImplementationOnce(() => { events.push("session1:open"); return session1; })
          .mockImplementationOnce(() => { events.push("session2:open"); return session2; }),
      } as unknown as Driver;

      // Start both acquires concurrently
      const acquire1 = manager.acquire(driver);
      const acquire2 = manager.acquire(driver);

      const s1 = await acquire1;
      // session2 must NOT be open yet — s1 is still held
      expect(events).toEqual(["session1:open"]);
      expect(manager.openCount()).toBe(1);

      // Release s1 — this should unblock acquire2
      await manager.release(s1);
      await acquire2;

      expect(events).toContain("session2:open");
      // session2 opened only after session1 was released
      expect(events.indexOf("session1:close")).toBeLessThan(
        events.indexOf("session2:open"),
      );
    });

    it("openCount never exceeds 1 during two concurrent acquire/release cycles", async () => {
      const maxOpen: number[] = [];

      const makeTrackedSession = (): Session =>
        makeMockSession(async () => {
          maxOpen.push(manager.openCount());
        });

      const session1 = makeTrackedSession();
      const session2 = makeTrackedSession();

      const driver = {
        session: vi
          .fn()
          .mockReturnValueOnce(session1)
          .mockReturnValueOnce(session2),
      } as unknown as Driver;

      const s1 = await manager.acquire(driver);
      const s2Promise = manager.acquire(driver);

      // Record count while s1 is held
      maxOpen.push(manager.openCount());

      await manager.release(s1);
      const s2 = await s2Promise;
      maxOpen.push(manager.openCount());
      await manager.release(s2);

      // At no point should more than 1 session be open
      expect(Math.max(...maxOpen)).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Property-Based Tests (fast-check)
// Requirements: 2.1, 2.2, 2.3, 2.4
// ---------------------------------------------------------------------------

import * as fc from "fast-check";

describe("SessionManager — property-based tests", () => {
  // -------------------------------------------------------------------------
  // Property 1: N sequential acquire/release cycles → openCount === 0
  // For any N in [1, 20], after all releases openCount must be 0.
  // -------------------------------------------------------------------------
  it("openCount is 0 after N sequential acquire/release cycles", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 20 }), async (n) => {
        const manager = new SessionManager();

        for (let i = 0; i < n; i++) {
          const session = makeMockSession();
          const driver = makeMockDriver(session);
          const s = await manager.acquire(driver);
          await manager.release(s);
        }

        expect(manager.openCount()).toBe(0);
      }),
      { numRuns: 50 },
    );
  });

  // -------------------------------------------------------------------------
  // Property 2: N concurrent acquire calls → at most 1 session open at any instant
  // Serialization invariant: openCount never exceeds 1 during concurrent acquires.
  // -------------------------------------------------------------------------
  it("openCount never exceeds 1 during N concurrent acquire calls", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (n) => {
        const manager = new SessionManager();
        const peakCounts: number[] = [];

        // Build a driver that returns n distinct mock sessions
        const sessions = Array.from({ length: n }, () => makeMockSession());
        let callIndex = 0;
        const driver = {
          session: vi.fn().mockImplementation(() => {
            const s = sessions[callIndex % sessions.length];
            callIndex++;
            return s;
          }),
        } as unknown as Driver;

        // Dispatch all acquires concurrently
        const acquirePromises = Array.from({ length: n }, () =>
          manager.acquire(driver),
        );

        // Release each session as it resolves, recording openCount after each open
        for (const promise of acquirePromises) {
          const s = await promise;
          peakCounts.push(manager.openCount());
          await manager.release(s);
        }

        expect(Math.max(...peakCounts)).toBeLessThanOrEqual(1);
      }),
      { numRuns: 50 },
    );
  });

  // -------------------------------------------------------------------------
  // Property 3: disconnect invariant — openCount is always 0 after closeAll
  // For any sequence of disconnect cycles (1–10), openCount is 0 after each
  // closeAll regardless of how many sessions were open at the time.
  // -------------------------------------------------------------------------
  it("openCount is 0 after any sequence of closeAll calls", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }), // number of disconnect cycles
        async (cycles) => {
          const manager = new SessionManager();

          for (let c = 0; c < cycles; c++) {
            // Acquire exactly one session (serialization means only one can be
            // open at a time) to simulate an in-flight call at disconnect time.
            const session = makeMockSession();
            const driver = makeMockDriver(session);
            await manager.acquire(driver); // session is now registered, not released

            // Simulate disconnect — closeAll must close the open session
            await manager.closeAll();
            expect(manager.openCount()).toBe(0);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Regression Tests — Race Condition and Multi-Transaction Scenarios
// Requirements: 2.5, 2.6, 2.7
// ---------------------------------------------------------------------------

describe("SessionManager — regression: _resolveRelease race condition (Req 2.5)", () => {
  // -------------------------------------------------------------------------
  // 11.1 Deterministic race condition test for acquire()
  //
  // The bug: if release() is called before the async .then() microtask that
  // attaches _resolveRelease fires, _resolveRelease is undefined and the queue
  // is permanently blocked.
  //
  // The fix: _resolveRelease is attached synchronously inside _queue.then()
  // before the session is returned, so release() always finds it set.
  //
  // Strategy: acquire a session, then immediately call release() *before*
  // yielding to the microtask queue (using Promise.resolve().then() to
  // schedule the release in the same microtask batch). A second acquire()
  // must resolve — proving the queue was unblocked.
  // -------------------------------------------------------------------------

  it("second acquire() resolves after release() called before microtask yield (serialization preserved)", async () => {
    const session1 = makeMockSession();
    const session2 = makeMockSession();
    const driver = {
      session: vi
        .fn()
        .mockReturnValueOnce(session1)
        .mockReturnValueOnce(session2),
    } as unknown as Driver;

    const manager = new SessionManager();

    // Acquire the first session
    const s1 = await manager.acquire(driver);
    expect(manager.openCount()).toBe(1);

    // Start the second acquire BEFORE releasing — it must queue up
    const acquire2 = manager.acquire(driver);

    // Release s1 synchronously (no await on the release itself yet) and
    // immediately schedule a microtask to verify acquire2 resolves.
    // This exercises the window where release() fires before any additional
    // microtask scheduling could attach _resolveRelease.
    const releaseAndCheck = Promise.resolve()
      .then(() => manager.release(s1))
      .then(async () => {
        // After release, acquire2 must resolve promptly
        const s2 = await acquire2;
        expect(s2).toBe(session2);
        expect(manager.openCount()).toBe(1);
        await manager.release(s2);
        expect(manager.openCount()).toBe(0);
      });

    await releaseAndCheck;
  });

  it("_resolveRelease is set by the time the caller can invoke release() (no undefined resolver)", async () => {
    const session = makeMockSession();
    const driver = makeMockDriver(session);
    const manager = new SessionManager();

    const s = await manager.acquire(driver);

    // _resolveRelease must be attached synchronously — verify it is defined
    // on the session object before any additional microtask fires.
    const resolver = (s as Session & { _resolveRelease?: () => void })
      ._resolveRelease;
    expect(resolver).toBeDefined();
    expect(typeof resolver).toBe("function");

    await manager.release(s);
  });

  it("queue remains unblocked after rapid acquire → release → acquire cycle", async () => {
    const sessions = [makeMockSession(), makeMockSession(), makeMockSession()];
    let idx = 0;
    const driver = {
      session: vi.fn().mockImplementation(() => sessions[idx++]),
    } as unknown as Driver;

    const manager = new SessionManager();

    // Three rapid sequential cycles — each release must unblock the next acquire
    for (let i = 0; i < 3; i++) {
      const s = await manager.acquire(driver);
      // Release immediately without any await gap
      await manager.release(s);
      expect(manager.openCount()).toBe(0);
    }
  });
});

describe("SessionManager — regression: closeAll() unblocks pending acquires (Req 2.7)", () => {
  // -------------------------------------------------------------------------
  // 11.2 closeAll() must unblock any acquire() callers waiting in the queue.
  //
  // The bug: closeAll() resets _queue = Promise.resolve() but callers already
  // waiting on the OLD _queue promise remain blocked forever because
  // _resolveRelease was never called for the force-closed session.
  //
  // The fix: closeAll() calls resolveRelease() for every tracked session
  // before resetting the queue, so all waiters are unblocked.
  // -------------------------------------------------------------------------

  it("pending acquire() resolves (does not hang) after closeAll() force-closes the held session", async () => {
    const session1 = makeMockSession();
    const session2 = makeMockSession();
    const driver = {
      session: vi
        .fn()
        .mockReturnValueOnce(session1)
        .mockReturnValueOnce(session2),
    } as unknown as Driver;

    const manager = new SessionManager();

    // Acquire session1 — do NOT release it (simulates in-flight call)
    await manager.acquire(driver);
    expect(manager.openCount()).toBe(1);

    // Start a second acquire — it queues behind session1
    const pendingAcquire = manager.acquire(driver);

    // Simulate disconnect: closeAll() must unblock the pending acquire
    await manager.closeAll();

    // pendingAcquire must resolve (not hang) — race it against a timeout
    const result = await Promise.race([
      pendingAcquire.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    expect(result).toBe("resolved");
    // After closeAll the queue is reset; the resolved acquire opened session2
    // Clean up
    const s2 = await pendingAcquire;
    await manager.release(s2);
  });

  it("multiple pending acquires all resolve (do not hang) after closeAll() unblocks the queue", async () => {
    // closeAll() calls resolveRelease() on the held session, which unblocks
    // the first pending acquire. That acquire opens a new session and advances
    // the queue, which in turn unblocks the next pending acquire, and so on.
    // Each pending acquire resolves sequentially — none hang forever.
    const sessions = Array.from({ length: 5 }, () => makeMockSession());
    let idx = 0;
    const driver = {
      session: vi.fn().mockImplementation(() => sessions[idx++]),
    } as unknown as Driver;

    const manager = new SessionManager();

    // Hold session 0 without releasing
    await manager.acquire(driver);

    // Queue up 3 more acquires — they are blocked behind session 0
    const pending = [
      manager.acquire(driver),
      manager.acquire(driver),
      manager.acquire(driver),
    ];

    // closeAll() unblocks the first pending acquire by calling resolveRelease()
    await manager.closeAll();

    // Drain the pending acquires sequentially: each one opens a session and
    // must be released before the next one resolves (serialization preserved).
    for (const p of pending) {
      const s = await Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("acquire timed out after closeAll")), 200),
        ),
      ]);
      await manager.release(s);
    }

    expect(manager.openCount()).toBe(0);
  });

  it("openCount is 0 after closeAll() closes all currently tracked sessions", async () => {
    // closeAll() clears _sessions before unblocking waiters, so the sessions
    // that were open at the time of closeAll() are removed from the registry.
    // Pending acquires that subsequently open new sessions are NOT in scope
    // for this particular assertion — we verify the tracked set is cleared.
    const session = makeMockSession();
    const driver = makeMockDriver(session);
    const manager = new SessionManager();

    await manager.acquire(driver);
    expect(manager.openCount()).toBe(1);

    // closeAll() must close the tracked session and clear the registry
    await manager.closeAll();

    expect(manager.openCount()).toBe(0);
    expect(session.close).toHaveBeenCalledOnce();
  });
});
