# Implementation Plan: Memgraph + Qdrant Migration

## Overview

Introduce adapter interfaces for graph and vector storage, implement four concrete adapters, wire factories, update all consumers, and add infrastructure support.

**Sub-files:**
- [Phase 1: Interfaces, Adapters & Factories](./tasks-phase1.md)
- [Phase 2: Consumers, Infrastructure & Tests](./tasks-phase2.md)
