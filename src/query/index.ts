/**
 * Query server — public API.
 * Requirements: 9.1–9.7, 23.3
 */
export { parseQueryIntent } from "./parse-intent.js";
export { executeQuery } from "./execute-query.js";
export { formatResponse } from "./format-response.js";
export { executeImpactAnalysis, calculateImpactRisk } from "./impact-analysis.js";
export { executeContextRetrieval } from "./context-retrieval.js";
export { executeDataFlowTrace } from "./data-flow-trace.js";
export { createQueryServer, startQueryServer, type QueryServerConfig } from "./server.js";
