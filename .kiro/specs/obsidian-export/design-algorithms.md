Part of the [Obsidian Export Design](./design.md).

# Algorithms

## Main Export Algorithm

```typescript
async function executeObsidianExport(config: ObsidianExportConfig): Promise<void> {
  // PRECONDITION: Neo4j is reachable, prefix is initialized
  // POSTCONDITION: Vault directory contains complete export
  const prefix = configurationManager.getPrefix();
  const dbConfig = getDatabaseConfig();
  const driver = await createDriver(dbConfig.neo4j.uri, dbConfig.neo4j.user, dbConfig.neo4j.password);
  try {
    const session = driver.session();
    try {
      const graphData = await fetchAllGraphData(session, prefix);
      if (graphData.symbols.length === 0) {
        console.error("[obsidian] No symbols found. Run 'typocop parse' first.");
        return;
      }
      const vaultContent = renderVault(graphData);
      const result = await writeVault(config.outputPath, vaultContent);
      console.error(`[obsidian] Exported ${result.filesWritten} files to ${config.outputPath}`);
    } finally { await session.close(); }
  } finally { await driver.close(); }
}
```

## Vault Rendering Algorithm

```typescript
function renderVault(data: GraphData): VaultContent {
  // PRECONDITION: data.symbols is a valid array
  // POSTCONDITION: files array has no duplicate relativePath values
  const files: VaultFile[] = [];
  const symbolsByFile = groupBy(data.symbols, (s) => s.filePath);
  const symbolToCluster = buildSymbolToClusterMap(data.clusterMemberships, data.clusters);
  const callerCounts = buildCallerCountMap(data.relationships);
  const outgoingCalls = buildOutgoingCallsMap(data.relationships);
  const incomingCalls = buildIncomingCallsMap(data.relationships);

  // Symbol files (one per source file)
  for (const [filePath, symbols] of symbolsByFile) {
    const mdPath = sourcePathToVaultPath(filePath);
    const content = renderSymbolFile(filePath, symbols, {
      symbolToCluster, callerCounts, outgoingCalls, incomingCalls,
    });
    files.push({ relativePath: mdPath, content });
  }

  // Cluster files + index
  for (const cluster of data.clusters) {
    const members = (data.clusterMemberships.get(cluster.id) ?? [])
      .map((id) => data.symbols.find((s) => s.id === id)).filter(Boolean);
    files.push({ relativePath: `_clusters/${slugify(cluster.name)}.md`, content: renderClusterFile(cluster, members) });
  }
  files.push({ relativePath: "_clusters/_index.md", content: renderClusterIndex(data.clusters) });

  // Process files + index
  for (const process of data.processes) {
    const steps = data.processSteps.get(process.id) ?? [];
    files.push({ relativePath: `_processes/${slugify(process.name)}.md`, content: renderProcessFile(process, steps) });
  }
  files.push({ relativePath: "_processes/_index.md", content: renderProcessIndex(data.processes) });

  // Top-level navigation
  files.push({ relativePath: "_index.md", content: renderNavigationIndex(data) });
  return { files };
}
```

## Vault Writing Algorithm

```typescript
async function writeVault(outputPath: string, content: VaultContent): Promise<WriteResult> {
  // PRECONDITION: outputPath is writable, content.files is non-empty
  // POSTCONDITION: output dir contains exactly content.files.length files
  await rm(outputPath, { recursive: true, force: true });
  let filesWritten = 0;
  let totalBytes = 0;
  const createdDirs = new Set<string>();

  for (const file of content.files) {
    const fullPath = join(outputPath, file.relativePath);
    const dir = dirname(fullPath);
    if (!createdDirs.has(dir)) {
      await mkdir(dir, { recursive: true });
      createdDirs.add(dir);
    }
    await writeFile(fullPath, file.content, "utf-8");
    filesWritten++;
    totalBytes += Buffer.byteLength(file.content, "utf-8");
  }

  return { filesWritten, directoriesCreated: createdDirs.size, totalBytes };
}
```

## Formal Specifications

### fetchAllGraphData()

**Preconditions**: session is open, prefix is non-empty string ending with `_`
**Postconditions**: Returns complete graph snapshot; does not modify graph data
**Loop Invariants**: N/A (query-based)

### renderVault()

**Preconditions**: data.symbols is a valid array; all IDs in maps reference valid entries
**Postconditions**: No duplicate relativePath values; every symbol appears in exactly one file
**Loop Invariants**: All previously processed files have unique paths

### writeVault()

**Preconditions**: outputPath is writable; content.files is non-empty
**Postconditions**: `filesWritten === content.files.length`; previous content removed
**Loop Invariants**: All previously written files remain on disk

### sourcePathToVaultPath()

**Preconditions**: filePath is relative, ends with recognized source extension
**Postconditions**: Returns path ending in `.md`; no `..` in output
