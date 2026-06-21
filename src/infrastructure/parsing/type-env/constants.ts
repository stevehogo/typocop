/**
 * AST node-type constant sets for the per-file type environment (Wave 3, Tier B).
 *
 * Ported from the legacy parser (typocop's pre-refactor parser lineage). These
 * are grammar-aware tree-sitter node-type strings, dependency-free of
 * `core/domain.ts` so the type-env stays tree-sitter-only and unit-testable.
 *
 * `FUNCTION_NODE_TYPES` drives scope detection (function-local variable scopes);
 * `FUNCTION_DECLARATION_TYPES` gates the C/C++ declarator handling in
 * `extractFunctionName`; `BUILT_IN_NAMES`/`isBuiltInOrNoise` is the standard-
 * library noise filter shared by the constructor-binding scanners.
 */

/**
 * Node types that represent function/method definitions across languages.
 * Used to find the enclosing function for a call site (scope boundaries).
 */
export const FUNCTION_NODE_TYPES: ReadonlySet<string> = new Set([
  // TypeScript/JavaScript
  "function_declaration",
  "arrow_function",
  "function_expression",
  "method_definition",
  "generator_function_declaration",
  // Python
  "function_definition",
  // Common async variants
  "async_function_declaration",
  "async_arrow_function",
  // Java
  "method_declaration",
  "constructor_declaration",
  // C#
  "local_function_statement",
  // Rust
  "function_item",
  "impl_item", // Methods inside impl blocks
  // PHP
  "anonymous_function",
  // Kotlin
  "lambda_literal",
  // Swift
  "init_declaration",
  "deinit_declaration",
  // Ruby
  "method", // def foo
  "singleton_method", // def self.foo
]);

/**
 * Node types for standard function declarations that need C/C++ declarator
 * handling. Used by `extractFunctionName` to determine how to extract the name.
 */
export const FUNCTION_DECLARATION_TYPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "function_definition",
  "async_function_declaration",
  "generator_function_declaration",
  "function_item",
]);

/**
 * Built-in function/method names that should not be tracked as call targets.
 * Covers JS/TS, Python, Kotlin, C/C++, PHP, Swift standard-library functions.
 */
export const BUILT_IN_NAMES: ReadonlySet<string> = new Set([
  // JavaScript/TypeScript
  "console", "log", "warn", "error", "info", "debug",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURI", "decodeURI", "encodeURIComponent", "decodeURIComponent",
  "JSON", "parse", "stringify",
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
  "Map", "Set", "WeakMap", "WeakSet",
  "Promise", "resolve", "reject", "then", "catch", "finally",
  "Math", "Date", "RegExp", "Error",
  "require", "import", "export", "fetch", "Response", "Request",
  "useState", "useEffect", "useCallback", "useMemo", "useRef", "useContext",
  "useReducer", "useLayoutEffect", "useImperativeHandle", "useDebugValue",
  "createElement", "createContext", "createRef", "forwardRef", "memo", "lazy",
  "map", "filter", "reduce", "forEach", "find", "findIndex", "some", "every",
  "includes", "indexOf", "slice", "splice", "concat", "join", "split",
  "push", "pop", "shift", "unshift", "sort", "reverse",
  "keys", "values", "entries", "assign", "freeze", "seal",
  "hasOwnProperty", "toString", "valueOf",
  // Python
  "print", "len", "range", "str", "int", "float", "list", "dict", "set", "tuple",
  "append", "extend", "update",
  "type", "isinstance", "issubclass", "getattr", "setattr", "hasattr",
  "enumerate", "zip", "sorted", "reversed", "min", "max", "sum", "abs",
  // Kotlin stdlib
  "println", "readLine", "requireNotNull", "check", "assert",
  "listOf", "mapOf", "setOf", "mutableListOf", "mutableMapOf", "mutableSetOf",
  "arrayOf", "sequenceOf", "also", "apply", "run", "with", "takeIf", "takeUnless",
  "TODO", "buildString", "buildList", "buildMap", "buildSet",
  "repeat", "synchronized",
  "launch", "async", "runBlocking", "withContext", "coroutineScope",
  "supervisorScope", "delay",
  "flow", "flowOf", "collect", "emit", "onEach",
  "buffer", "conflate", "distinctUntilChanged",
  "flatMapLatest", "flatMapMerge", "combine",
  "stateIn", "shareIn", "launchIn",
  "to", "until", "downTo", "step",
  // C/C++ standard library
  "printf", "fprintf", "sprintf", "snprintf", "vprintf", "vfprintf", "vsprintf", "vsnprintf",
  "scanf", "fscanf", "sscanf",
  "malloc", "calloc", "realloc", "free", "memcpy", "memmove", "memset", "memcmp",
  "strlen", "strcpy", "strncpy", "strcat", "strncat", "strcmp", "strncmp", "strstr", "strchr", "strrchr",
  "atoi", "atol", "atof", "strtol", "strtoul", "strtoll", "strtoull", "strtod",
  "sizeof", "offsetof", "typeof",
  "abort", "exit", "_exit",
  "fopen", "fclose", "fread", "fwrite", "fseek", "ftell", "rewind", "fflush", "fgets", "fputs",
  "likely", "unlikely", "BUG", "BUG_ON", "WARN", "WARN_ON", "WARN_ONCE",
  "IS_ERR", "PTR_ERR", "ERR_PTR", "IS_ERR_OR_NULL",
  "ARRAY_SIZE", "container_of", "list_for_each_entry", "list_for_each_entry_safe",
  "clamp", "swap",
  "pr_info", "pr_warn", "pr_err", "pr_debug", "pr_notice", "pr_crit", "pr_emerg",
  "printk", "dev_info", "dev_warn", "dev_err", "dev_dbg",
  "GFP_KERNEL", "GFP_ATOMIC",
  "spin_lock", "spin_unlock", "spin_lock_irqsave", "spin_unlock_irqrestore",
  "mutex_lock", "mutex_unlock", "mutex_init",
  "kfree", "kmalloc", "kzalloc", "kcalloc", "krealloc", "kvmalloc", "kvfree",
  "get", "put",
  // C# / .NET built-ins
  "Console", "WriteLine", "ReadLine", "Write",
  "Task", "Run", "Wait", "WhenAll", "WhenAny", "FromResult", "Delay", "ContinueWith",
  "ConfigureAwait", "GetAwaiter", "GetResult",
  "ToString", "GetType", "Equals", "GetHashCode", "ReferenceEquals",
  "Add", "Remove", "Contains", "Clear", "Count", "Any", "All",
  "Where", "Select", "SelectMany", "OrderBy", "OrderByDescending", "GroupBy",
  "First", "FirstOrDefault", "Single", "SingleOrDefault", "Last", "LastOrDefault",
  "ToList", "ToArray", "ToDictionary", "AsEnumerable", "AsQueryable",
  "Aggregate", "Sum", "Average", "Min", "Max", "Distinct", "Skip", "Take",
  "Format", "IsNullOrEmpty", "IsNullOrWhiteSpace",
  "Trim", "TrimStart", "TrimEnd", "Replace", "StartsWith", "EndsWith",
  "Convert", "ToInt32", "ToDouble", "ToBoolean", "ToByte",
  "Abs", "Ceiling", "Floor", "Round", "Pow", "Sqrt",
  "Dispose", "Close",
  "TryParse", "Parse",
  "AddRange", "RemoveAt", "RemoveAll", "FindAll", "Exists", "TrueForAll",
  "ContainsKey", "TryGetValue", "AddOrUpdate",
  "Throw", "ThrowIfNull",
  // PHP built-ins
  "echo", "isset", "empty", "unset", "array", "compact", "extract",
  "strpos", "strrpos", "substr", "strtolower", "strtoupper", "trim",
  "ltrim", "rtrim", "str_replace", "str_contains", "str_starts_with", "str_ends_with",
  "number_format",
  "array_map", "array_filter", "array_reduce", "array_push", "array_pop", "array_shift",
  "array_unshift", "array_slice", "array_splice", "array_merge", "array_keys", "array_values",
  "array_key_exists", "in_array", "array_search", "array_unique", "usort", "rsort",
  "json_encode", "json_decode", "serialize", "unserialize",
  "intval", "floatval", "strval", "boolval", "is_null", "is_string", "is_int", "is_array",
  "is_object", "is_numeric", "is_bool", "is_float",
  "var_dump", "print_r", "var_export",
  "time", "strtotime", "mktime", "microtime",
  "file_exists", "file_get_contents", "file_put_contents", "is_file", "is_dir",
  "preg_match", "preg_match_all", "preg_replace", "preg_split",
  "header", "session_start", "session_destroy", "ob_start", "ob_end_clean", "ob_get_clean",
  "dd", "dump",
  // Swift/iOS built-ins and standard library
  "debugPrint", "fatalError", "precondition", "preconditionFailure",
  "assertionFailure", "NSLog",
  "stride", "sequence", "repeatElement",
  "withUnsafePointer", "withUnsafeMutablePointer", "withUnsafeBytes",
  "autoreleasepool", "unsafeBitCast", "unsafeDowncast", "numericCast",
  "MemoryLayout",
  "flatMap", "compactMap",
  "first", "last", "prefix", "suffix", "dropFirst", "dropLast",
  "enumerated", "joined",
  "insert", "removeAll", "removeFirst", "removeLast",
  "isEmpty", "index", "startIndex", "endIndex",
  "addSubview", "removeFromSuperview", "layoutSubviews", "setNeedsLayout",
  "layoutIfNeeded", "setNeedsDisplay", "invalidateIntrinsicContentSize",
  "addTarget", "removeTarget", "addGestureRecognizer",
  "addConstraint", "addConstraints", "removeConstraint", "removeConstraints",
  "NSLocalizedString", "Bundle",
  "reloadData", "reloadSections", "reloadRows", "performBatchUpdates",
  "register", "dequeueReusableCell", "dequeueReusableSupplementaryView",
  "beginUpdates", "endUpdates", "insertRows", "deleteRows", "insertSections", "deleteSections",
  "present", "dismiss", "pushViewController", "popViewController", "popToRootViewController",
  "performSegue", "prepare",
  "DispatchQueue", "sync", "asyncAfter",
  "withCheckedContinuation", "withCheckedThrowingContinuation",
  "sink", "store", "receive", "subscribe",
  "addObserver", "removeObserver", "post", "NotificationCenter",
  // Rust standard library (common noise in call graphs)
  "unwrap", "expect", "unwrap_or", "unwrap_or_else", "unwrap_or_default",
  "ok", "err", "is_ok", "is_err", "map_err", "and_then", "or_else",
  "clone", "to_string", "to_owned", "into", "from", "as_ref", "as_mut",
  "iter", "into_iter", "fold", "for_each",
  "is_empty",
  "format", "write", "writeln", "panic", "unreachable", "todo", "unimplemented",
  "vec", "eprintln", "dbg",
  "lock", "read", "write", "try_lock",
  "spawn", "join", "sleep",
  "Some", "None", "Ok", "Err",
  // Ruby built-ins and Kernel methods
  "puts", "p", "pp", "raise", "fail",
  "require_relative", "load", "autoload",
  "include", "extend", "prepend",
  "attr_accessor", "attr_reader", "attr_writer",
  "public", "private", "protected", "module_function",
  "lambda", "proc", "block_given?",
  "nil?", "is_a?", "kind_of?", "instance_of?", "respond_to?",
  "frozen?", "dup", "tap", "yield_self",
  "each", "select", "reject", "detect", "collect",
  "inject", "flat_map", "each_with_object", "each_with_index",
  "any?", "all?", "none?",
  "sort_by", "min_by", "max_by",
  "group_by", "partition", "compact", "flatten", "uniq",
]);

/** Check if a name is a built-in function or common noise that should be filtered. */
export const isBuiltInOrNoise = (name: string): boolean => BUILT_IN_NAMES.has(name);
