// The `users` DB model. Lives under an `entities/` directory and is named
// `users`, so the file-path model-detection heuristic resolves it to table
// `users` WITHOUT needing a populated signature (the parser does not emit
// decorator text into Symbol.signature in this wave).
export class users {
  id = 0;
  email = "";
}
