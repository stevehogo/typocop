/**
 * Shared framework-layer types — extracted so framework-layers.ts (which holds
 * the classifier + imports the value FRAMEWORK_LAYER_MAP) and
 * framework-layer-map.ts (which holds the per-framework configs) can both
 * reference these without importing each other (breaks the prior cycle).
 */

/** The six possible trace layer classifications. */
export type TraceLayer = "api" | "controller" | "service" | "repository" | "model" | "unknown";

/** Layer pattern configuration for a specific framework. */
export interface FrameworkLayerConfig {
  readonly framework: string;
  readonly layers: Readonly<Record<TraceLayer, readonly RegExp[]>>;
}
