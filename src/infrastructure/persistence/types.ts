// Re-export shim — DB adapter ports moved to core/ports/persistence.ts (PR2).
// Kept so any remaining importers of the old path keep compiling; removed in PR9.
export * from "../../core/ports/persistence.js";
