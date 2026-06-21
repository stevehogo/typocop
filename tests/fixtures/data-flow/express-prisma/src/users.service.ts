// Service layer: delegates to the repository's read method.
import { findManyUsers } from "./users.repository.js";

export function listUsersService(): unknown {
  return findManyUsers();
}
