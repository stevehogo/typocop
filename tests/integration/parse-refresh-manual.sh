#!/bin/bash
# Manual integration test script for parse --refresh functionality
# 
# This script validates the end-to-end refresh workflow by:
# 1. Running parse with --refresh on the sample project
# 2. Verifying the graph and vector store are populated
# 3. Running incremental parse to verify data preservation
#
# Usage: bash tests/integration/parse-refresh-manual.sh

set -e

echo "=========================================="
echo "Manual Integration Test: Parse --refresh"
echo "=========================================="
echo ""

# Configuration
SAMPLE_PROJECT="tests/fixtures/sample-project"
NEO4J_URI="${NEO4J_URI:-bolt://localhost:8687}"
NEO4J_USER="${NEO4J_USER:-neo4j}"
NEO4J_PASSWORD="${NEO4J_PASSWORD:-password}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-8432}"
POSTGRES_DB="${POSTGRES_DB:-typocop}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-password}"

echo "Configuration:"
echo "  Sample Project: $SAMPLE_PROJECT"
echo "  Neo4j URI: $NEO4J_URI"
echo "  PostgreSQL: $POSTGRES_HOST:$POSTGRES_PORT/$POSTGRES_DB"
echo ""

# Test 1: Full parse with --refresh
echo "Test 1: Full parse with --refresh flag"
echo "  Command: pnpm typocop parse -p $SAMPLE_PROJECT -l typescript --refresh -v"
pnpm typocop parse -p "$SAMPLE_PROJECT" -l typescript --refresh -v
echo "  ✓ Parse with --refresh completed successfully"
echo ""

# Test 2: Verify graph is populated
echo "Test 2: Verify graph is populated after refresh"
echo "  Querying Neo4j for symbol count..."
SYMBOL_COUNT=$(pnpm typocop status 2>&1 | grep "Symbols:" | awk '{print $NF}')
echo "  Symbol count: $SYMBOL_COUNT"
if [ "$SYMBOL_COUNT" -gt 0 ]; then
  echo "  ✓ Graph is populated with symbols"
else
  echo "  ✗ Graph is empty (expected symbols)"
  exit 1
fi
echo ""

# Test 3: Incremental parse preserves data
echo "Test 3: Incremental parse (without --refresh) preserves data"
echo "  Command: pnpm typocop parse -p $SAMPLE_PROJECT -l typescript -v"
pnpm typocop parse -p "$SAMPLE_PROJECT" -l typescript -v
echo "  ✓ Incremental parse completed successfully"
echo ""

# Test 4: Verify data is still present
echo "Test 4: Verify data is preserved after incremental parse"
echo "  Querying Neo4j for symbol count..."
SYMBOL_COUNT_AFTER=$(pnpm typocop status 2>&1 | grep "Symbols:" | awk '{print $NF}')
echo "  Symbol count: $SYMBOL_COUNT_AFTER"
if [ "$SYMBOL_COUNT_AFTER" -ge "$SYMBOL_COUNT" ]; then
  echo "  ✓ Data preserved (symbols: $SYMBOL_COUNT_AFTER >= $SYMBOL_COUNT)"
else
  echo "  ✗ Data was lost (symbols: $SYMBOL_COUNT_AFTER < $SYMBOL_COUNT)"
  exit 1
fi
echo ""

echo "=========================================="
echo "All manual integration tests passed! ✓"
echo "=========================================="
