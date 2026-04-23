/**
 * Framework-aware layer classification for data flow tracing.
 * Replaces the hardcoded LAYER_PATTERNS with framework-detected layer mappings.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */
import type { GraphNode } from "../db/types.js";
import { prop } from "../db/types.js";
import { FRAMEWORK_LAYER_MAP } from "./framework-layer-map.js";

/** The six possible trace layer classifications. */
export type TraceLayer = "api" | "controller" | "service" | "repository" | "model" | "unknown";

/** Layer pattern configuration for a specific framework. */
export interface FrameworkLayerConfig {
  readonly framework: string;
  readonly layers: Readonly<Record<TraceLayer, readonly RegExp[]>>;
}

/** Order in which layers are checked during classification. */
const LAYER_ORDER: readonly TraceLayer[] = ["api", "controller", "service", "repository", "model"] as const;

/** Generic layer config matching the original LAYER_PATTERNS from data-flow-trace.ts. */
export const GENERIC_LAYER_CONFIG: FrameworkLayerConfig = {
  framework: "generic",
  layers: {
    api: [/endpoint/i, /route/i, /controller.*action/i, /api/i, /@get/i, /@post/i, /@put/i, /@delete/i],
    controller: [/controller/i, /handler/i],
    service: [/service/i, /manager/i, /business/i],
    repository: [/repository/i, /dao/i, /store/i],
    model: [/model/i, /entity/i, /schema/i, /table/i],
    unknown: [],
  },
};

/**
 * Detect framework from a file path using directory structure and file extension patterns.
 * Derived from the legacy detectFrameworkFromPath logic.
 *
 * Requirements: 4.3
 */
export function detectFramework(filePath: string): string | null {
  let p = filePath.toLowerCase().replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p;

  if (p.includes("/controllers/") && (p.endsWith(".ts") || p.endsWith(".js"))) {
    return "nestjs";
  }
  if ((p.includes("/controller/") || p.includes("/controllers/")) && p.endsWith(".java")) {
    return "spring";
  }
  if (p.endsWith("controller.java") || p.endsWith("controller.kt")) {
    return "spring";
  }
  if (p.includes("/http/controllers/") && p.endsWith(".php")) {
    return "laravel";
  }
  if (p.endsWith("controller.php")) {
    return "laravel";
  }
  if (p.includes("/routes/") && (p.endsWith(".ts") || p.endsWith(".js"))) {
    return "express";
  }
  if (p.endsWith("views.py") || p.endsWith("urls.py")) {
    return "django";
  }
  if ((p.includes("/routers/") || p.includes("/endpoints/")) && p.endsWith(".py")) {
    return "fastapi";
  }
  if (p.includes("/pages/") || (p.includes("/app/") && p.endsWith("page.tsx"))) {
    return "nextjs";
  }
  if (p.includes("/controllers/") && p.endsWith(".cs")) {
    return "aspnet";
  }

  return null;
}

/**
 * Classify a graph node into a trace layer using framework-aware patterns.
 * Accepts an optional framework hint; auto-detects from file path if not provided.
 * Falls back to generic patterns when no framework is detected.
 *
 * Requirements: 4.2, 4.4, 4.6
 */
export function classifyLayer(node: GraphNode, frameworkHint?: string): TraceLayer {
  const name = prop(node, "name").toLowerCase();
  const filePath = prop(node, "filePath").toLowerCase();
  const signature = (node.properties["signature"] as string ?? "").toLowerCase();
  const combined = `${name} ${filePath} ${signature}`;

  let framework = frameworkHint?.toLowerCase() ?? null;
  if (!framework) {
    framework = detectFramework(filePath);
  }

  const config = framework
    ? FRAMEWORK_LAYER_MAP.get(framework) ?? GENERIC_LAYER_CONFIG
    : GENERIC_LAYER_CONFIG;

  for (const layer of LAYER_ORDER) {
    const patterns = config.layers[layer];
    if (patterns.some((p) => p.test(combined))) {
      return layer;
    }
  }

  return "unknown";
}

export { FRAMEWORK_LAYER_MAP };
