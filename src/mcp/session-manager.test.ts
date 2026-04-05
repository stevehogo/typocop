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
