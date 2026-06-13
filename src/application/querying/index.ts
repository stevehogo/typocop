/**
 * Query server — public API.
 * Requirements: 9.1–9.7, 23.3
 */
export { parseQueryIntent } from "./parse-intent.js";
export { executeQuery } from "./execute-query.js";
export { formatResponse } from "./format-response.js";
export { executeImpactAnalysis, calculateImpactRisk, type ImpactAnalysisResult } from "./impact-analysis.js";
export { executeContextRetrieval, type ContextRetrievalResult } from "./context-retrieval.js";
export { executeDataFlowTrace, type DataFlowTraceResult } from "./data-flow-trace.js";
export { preprocessQuery, isValidQuery } from "./preprocess.js";
