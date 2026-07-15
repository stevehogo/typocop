// The `users` DB model under an `entities/` directory (file-path model
// detection resolves it to table `users`). In a real TypeORM app this would
// carry an `@Entity('users')` decorator; the file-path heuristic detects it
// regardless so the fixture indexes end-to-end without a populated signature.
export class users {
  id = 0;
  name = "";
}
