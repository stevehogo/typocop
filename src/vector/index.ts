/**
 * Vector store interface — public API.
 * Requirements: 17.1–17.5, 19.3, 19.4, 20.4
 */
export { createPool, initVectorStore, withRetry } from "./connection.js";
export { indexSymbol } from "./index-store.js";
export { semanticSearch } from "./search.js";
