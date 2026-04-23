Part of the [Connection Pool Design](./design.md).
See also: [Formal Specifications](./design-algorithms.md)

# Algorithmic Pseudocode

## Acquire Algorithm

```pascal
ALGORITHM acquire()
INPUT: none (uses pool internal state)
OUTPUT: PooledConnection

BEGIN
  IF pool.drained THEN
    THROW Error("Pool is drained")
  END IF

  WHILE idle.length > 0 DO
    conn ← idle.pop()
    
    IF validateConnection(conn) THEN
      conn.lastUsedAt ← Date.now()
      active.add(conn)
      RETURN conn
    ELSE
      conn.connection.close()
      totalCount ← totalCount - 1
    END IF
  END WHILE

  IF totalCount < config.maxConnections THEN
    conn ← createConnection()
    active.add(conn)
    RETURN conn
  END IF

  result ← waitForRelease(config.acquireTimeoutMs)
  
  IF result IS timeout THEN
    THROW PoolExhaustedError(dbPath, acquireTimeoutMs)
  END IF

  RETURN result.connection
END
```

## Release Algorithm

```pascal
ALGORITHM release(conn)
INPUT: conn of type PooledConnection
OUTPUT: void

BEGIN
  IF conn NOT IN active THEN
    LOG warning "Connection already released"
    RETURN
  END IF

  active.remove(conn)

  IF pool.drained THEN
    conn.connection.close()
    totalCount ← totalCount - 1
    IF totalCount = 0 THEN
      SIGNAL drainComplete
    END IF
    RETURN
  END IF

  IF waitQueue.length > 0 THEN
    waiter ← waitQueue.dequeue()
    conn.lastUsedAt ← Date.now()
    active.add(conn)
    waiter.resolve(conn)
    RETURN
  END IF

  conn.lastUsedAt ← Date.now()
  idle.push(conn)
  resetIdleTimer()
END
```

## Idle Eviction Algorithm

```pascal
ALGORITHM evictIdleConnections()
INPUT: none
OUTPUT: void

BEGIN
  now ← Date.now()
  
  FOR EACH conn IN idle DO
    IF now - conn.lastUsedAt > config.idleTimeoutMs THEN
      IF totalCount > config.minConnections THEN
        idle.remove(conn)
        conn.connection.close()
        totalCount ← totalCount - 1
      END IF
    END IF
  END FOR
END
```

## Health Check Validation

```pascal
ALGORITHM validateConnection(conn)
INPUT: conn of type PooledConnection
OUTPUT: boolean

BEGIN
  TRY
    result ← conn.connection.query("RETURN 1")
    RETURN result IS NOT error
  CATCH error
    RETURN false
  END TRY
END
```

## Drain Algorithm

```pascal
ALGORITHM drain()
BEGIN
  pool.drained ← true
  stopIdleTimer()
  FOR EACH conn IN idle DO conn.connection.close(); totalCount-- END FOR
  idle.clear()
  FOR EACH waiter IN waitQueue DO waiter.reject(Error("Pool draining")) END FOR
  waitQueue.clear()
  IF active.size > 0 THEN AWAIT drainCompleteSignal END IF
  database.close()
  connectionCache.delete(dbPath)
  releaseFileLock(dbPath)
END
```
