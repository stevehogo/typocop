// Re-export shim — domain types moved to core/domain.ts (PR2).
// Kept so any remaining importers of the old path keep compiling; removed in PR9.
export * from "../core/domain.js";
