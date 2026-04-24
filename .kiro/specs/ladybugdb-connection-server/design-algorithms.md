Part of the [LadybugDB Connection Server Design](./design.md).

# Algorithmic Pseudocode & Key Functions

## Server Startup Algorithm

```typescript
async function startConnectionServer(config: LadybugServerConfig): Promise<void> {
  const runtime = new EmbeddedDatabaseRuntime();
  await runtime.open(config.dbPath, config.prefix);

  const scheduler = new RequestScheduler(config.maxConcurrency, config.maxQueue);
  const metrics = new MetricsCollector();
  const router = new OperationRouter(runtime, scheduler, metrics);

  const grpcServer = createGrpcServer();
  registerHealthService(grpcServer, runtime);
  registerAdminService(grpcServer, metrics, scheduler, runtime);
  registerGraphService(grpcServer, router);
  registerVectorService(grpcServer, router);

  await grpcServer.bindAsync(`${config.host}:${config.port}`);
  grpcServer.start();

  const shutdown = async (signal: string): Promise<void> => {
    grpcServer.tryShutdown(async () => {
      await scheduler.drain();
      await runtime.close();
      await removeDiscoveryFile(config);
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  if (config.idleTtlMs > 0) {
    startIdleWatcher(scheduler, config.idleTtlMs, () => shutdown("idle-timeout"));
  }
}
```

**Pre**: `runtimeMode === "server"`, `dbPath` writable, `port` available.
**Post**: gRPC listening, DB open, shutdown handlers registered.

## Client Autostart Algorithm

```typescript
async function ensureServerAndConnect(config: LadybugClientConfig): Promise<RemoteDatabaseAdapter> {
  // Step 1: Try direct connection
  if (await checkHealth(config.serverUrl, 2000)) {
    return createRemoteAdapter(config);
  }
  // Step 2: Fail fast if autostart disabled
  if (!config.autostart) throw new ServerUnavailableError(config.serverUrl);

  // Step 3: Acquire cross-process lock
  await acquireLockFile(config.lockPath, { retries: 5, stale: config.startupTimeoutMs });
  try {
    // Step 4: Re-check (another process may have started it)
    if (await checkHealth(config.serverUrl, 2000)) return createRemoteAdapter(config);

    // Step 5: Spawn server detached
    const proc = spawnDetached("node", ["dist/db-server/main.js",
      "--db-path", config.dbPath, "--prefix", config.prefix,
      "--host", extractHost(config.serverUrl),
      "--port", String(extractPort(config.serverUrl))]);
    proc.unref();

    // Step 6: Poll readiness
    const start = Date.now();
    while (Date.now() - start < config.startupTimeoutMs) {
      await sleep(200);
      if (await checkHealth(config.serverUrl, 1000)) {
        await writeDiscoveryFile(config.discoveryPath, {
          pid: proc.pid!, startedAt: new Date().toISOString(),
          prefix: config.prefix, dbPath: config.dbPath, url: config.serverUrl,
        });
        return createRemoteAdapter(config);
      }
    }
    throw new ServerStartupTimeoutError(config.startupTimeoutMs);
  } finally {
    await releaseLockFile(config.lockPath);
  }
}
```

**Pre**: `runtimeMode === "client"`, `serverUrl` valid, `lockPath` writable.
**Post**: Connected adapter returned, lock released, discovery file written if autostarted.
**Loop invariant**: elapsed < `startupTimeoutMs`, each iteration sleeps 200ms.

## Request Scheduler Algorithm

```typescript
async function enqueueRequest<T>(sched: SchedulerState, req: ScheduledRequest<T>): Promise<T> {
  if (sched.draining) throw new ServerDrainingError();
  if (sched.queue.length >= sched.maxQueue) throw new QueueFullError(sched.maxQueue);

  const entry = { ...req, enqueuedAt: Date.now() };
  insertByPriority(sched.queue, entry); // admin > interactive_read > background_write

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      removeFromQueue(sched.queue, entry.id);
      sched.stats.totalTimedOut++;
      reject(new RequestTimeoutError(req.id, req.timeoutMs));
    }, req.timeoutMs);

    entry.resolve = (r: T) => { clearTimeout(timeout); resolve(r); };
    entry.reject = (e: Error) => { clearTimeout(timeout); reject(e); };
    tryExecuteNext(sched);
  });
}

function tryExecuteNext(sched: SchedulerState): void {
  while (sched.inFlight < sched.maxConcurrency && sched.queue.length > 0) {
    const next = sched.queue.shift()!;
    if (Date.now() - next.enqueuedAt > next.timeoutMs) {
      sched.stats.totalTimedOut++;
      next.reject(new RequestTimeoutError(next.id, next.timeoutMs));
      continue;
    }
    sched.inFlight++;
    sched.stats.totalProcessed++;
    next.execute()
      .then(r => { sched.inFlight--; next.resolve(r); tryExecuteNext(sched); })
      .catch(e => { sched.inFlight--; next.reject(e); tryExecuteNext(sched); });
  }
}
```

**Pre**: Not draining, `timeoutMs > 0`, queue not full.
**Post**: Request executed or rejected. `inFlight <= maxConcurrency` always.
**Loop invariant**: Queue ordered by priority; timed-out entries dropped before execution.

## Database Adapter Factory (Extended)

`createDatabaseAdapter(config)` checks `config.ladybugdb.runtimeMode`. If `"client"`, it builds a `LadybugClientConfig` from the FullConfig fields, calls `ensureServerAndConnect`, then creates and initializes a `RemoteDatabaseAdapter`. If `"server"` (default), it creates and initializes a `LadybugDatabaseAdapter` as today.

## Key Function Formal Specifications

| Function | Pre | Post |
|----------|-----|------|
| `startConnectionServer` | mode=server, dbPath writable, port free | gRPC listening, Health.Check=SERVING |
| `ensureServerAndConnect` | mode=client, serverUrl valid | Connected adapter, lock released |
| `RequestScheduler.enqueue` | Not draining, timeout>0, queue<max | Executed or rejected within timeout |
| `RequestScheduler.drain` | Operational | draining=true, inFlight=0, queue empty |
| `RemoteDatabaseAdapter.initialize` | Server running | gRPC connected, sub-adapters created |
| `createDatabaseAdapter` | Config valid | Initialized adapter (local or remote) |
