// NestJS-style users controller. The @Get() handler delegates to the service
// layer, which reads the `users` table via a TypeORM repository. The decorator
// text the route detector keys on lives on the method/class declaration line
// (sourced from Symbol.signature once the framework signature pass runs — see
// the integration test's signature-enrichment seam).
import { findAllUsers } from "./users.service.js";

export class UsersController {
  list(): unknown {
    return findAllUsers();
  }
}
