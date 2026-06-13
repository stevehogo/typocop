// Security and input validation module (Req 22, 23)

export { sanitizeQuery, containsMaliciousPatterns } from './sanitize.js';
export { isValidPath, containsTraversalPattern } from './validate-path.js';
export {
  containsSourceCode,
  verifyEmbeddingText,
  verifyEnrichmentPrompt,
  getPrivacyCompliance,
  type ExternalDataPolicy,
  type PrivacyCompliance,
  EXTERNAL_DATA_POLICIES,
} from './privacy.js';
