// Repository layer: the actual DB read. `findMany` is in the curated DB-read
// method set, so the call into it is linked to the `users` model. The User model
// is declared in this same file (a `*.repository.ts` under the users feature),
// and the caller name `findManyUsers` contains the table name `user`, so the
// model resolves by the name/path-substring strategy without a signature.
import { prisma } from "./prisma.js";

export function findManyUsers(): unknown {
  return prisma.users.findMany();
}
