// Service layer: a free function delegating to the repository read.
import { findManyUsers } from "./users.repository.js";

export function findAllUsers(): unknown {
  return findManyUsers();
}
