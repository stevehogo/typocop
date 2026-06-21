// Repository layer: the actual DB read. `find` is in the curated read set; the
// caller name `findManyUsers` contains the table name `users`, so the read
// resolves to the `users` entity via the name-substring strategy.
import { repo } from "./db.js";

export function findManyUsers(): unknown {
  return repo.find();
}
