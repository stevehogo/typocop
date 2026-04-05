/**
 * SessionManager — serializes Neo4j session acquisition per MCP connection
 * and closes all tracked sessions on disconnect to prevent zombie transactions.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4
 */
import type { Driver, Session } from "neo4j-driver";

/**
 * Manages Neo4j session lifecycle for a single MCP connection.
 *
 * Invariants:
 *   - At most one session is active at any instant (serialized via async mutex).
 *   - All tracked sessions are closed when closeAll() is called.
 *   - openCount() returns 0 after closeAll() completes.
 */
export class SessionManager {
  /** Registry of all sessions opened on the current connection. */
  private readonly _sessions: Set<Session> = new Set();

  /**
   * Async mutex — each acquire() chains onto this promise so that only one
   * session is active at a time. Initialized to a resolved promise so the
   * first acquire() proceeds immediately.
   */
  private _queue: Promise<void> = Promise.resolve();

  /**
   * Opens a Neo4j session, registers it in the session registry, and returns
   * it. Serializes access: if a session is already open, this call waits until
   * release() is called for the previous session before opening a new one.
   *
   * @param driver - The shared Neo4j Driver instance.
   * @returns The newly opened Session.
   */
  public acquire(driver: Driver): Promise<Session> {
    let resolveRelease!: () => void;

    // Chain onto the queue so the next acquire() waits for this one's release.
    const acquired = this._queue.then(() => {
      const session = driver.session();
      this._sessions.add(session);
      return session;
    });

    // The next acquire() will wait until resolveRelease() is called.
    this._queue = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });

    // Attach the resolver to the session so release() can unblock the queue.
    acquired.then((session) => {
      (session as Session & { _resolveRelease: () => void })._resolveRelease =
        resolveRelease;
    });

    return acquired;
  }

  /**
   * Closes the given session, removes it from the registry, and unblocks the
   * next queued acquire() call.
   *
   * @param session - The session previously returned by acquire().
   */
  public async release(session: Session): Promise<void> {
    await session.close();
    this._sessions.delete(session);

    // Unblock the next acquire() waiting in the queue.
    const resolver = (session as Session & { _resolveRelease?: () => void })
      ._resolveRelease;
    if (resolver) {
      resolver();
    }
  }

  /**
   * Closes all tracked sessions in parallel and clears the registry.
   * Safe to call with zero open sessions — it is a no-op in that case.
   * Uses Promise.allSettled so a single close() failure does not prevent
   * the remaining sessions from being closed.
   */
  public async closeAll(): Promise<void> {
    const sessions = [...this._sessions];
    this._sessions.clear();

    await Promise.allSettled(
      sessions.map(async (session) => {
        await session.close();
        // Unblock any pending acquire() that was waiting on this session.
        const resolver = (session as Session & { _resolveRelease?: () => void })
          ._resolveRelease;
        if (resolver) {
          resolver();
        }
      }),
    );

    // Reset the queue so subsequent acquire() calls proceed immediately.
    this._queue = Promise.resolve();
  }

  /**
   * Returns the number of currently open (tracked) sessions.
   * Primarily used for testing and observability.
   */
  public openCount(): number {
    return this._sessions.size;
  }
}
