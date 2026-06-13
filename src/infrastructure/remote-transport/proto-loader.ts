/**
 * Single source of truth for loading the LadybugDB connection proto.
 *
 * De-triplicated from db/remote-grpc.ts, db/autostart-runtime.ts and
 * db-server/server.ts (TARGET-ARCHITECTURE §4.3). The proto lives at the repo
 * root `proto/` and is NOT copied into `dist/`. This module compiles to
 * `dist/infrastructure/remote-transport/proto-loader.js`, so the path climbs
 * remote-transport → infrastructure → dist → <root>, then into `proto/`
 * (three `..` segments). Getting this depth wrong fails only at RUNTIME, never
 * at typecheck (§13.3) — change it with care.
 */
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

export const PROTO_PATH = fileURLToPath(
  new URL("../../../proto/ladybug_connection.proto", import.meta.url),
);
export const PROTO_PACKAGE = "typocop.ladybug.v1";

const LOAD_OPTIONS = {
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  keepCase: false,
};

/** Walk a dotted package name (e.g. "typocop.ladybug.v1") into a descriptor. */
export function resolveProtoPackage(
  root: Record<string, unknown>,
  packageName: string = PROTO_PACKAGE,
): Record<string, unknown> {
  let current: unknown = root;
  for (const key of packageName.split(".")) {
    if (!current || typeof current !== "object" || !(key in current)) {
      throw new Error(`Proto package "${packageName}" is unavailable`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (!current || typeof current !== "object") {
    throw new Error(`Proto package "${packageName}" is unavailable`);
  }
  return current as Record<string, unknown>;
}

/**
 * Load + resolve the connection proto package. Returns the package descriptor
 * whose members (`Graph`, `Vector`, `Health`) are the gRPC service client
 * constructors (each with a `.service` definition for the server side).
 */
export function loadConnectionProtoPackage(): Record<string, any> {
  const definition = protoLoader.loadSync(PROTO_PATH, LOAD_OPTIONS);
  const descriptor = grpc.loadPackageDefinition(definition) as Record<string, unknown>;
  return resolveProtoPackage(descriptor, PROTO_PACKAGE) as Record<string, any>;
}
