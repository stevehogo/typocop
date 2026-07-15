// Express-style users controller in a *.controller.ts route file. The handler
// delegates to the service which performs a DB read on the `users` table.
import { listUsersService } from "./users.service.js";

export function listUsers(): unknown {
  return listUsersService();
}
