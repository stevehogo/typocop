# Design: Use Cases & Correctness Properties

Part of the [Code Graph Analyzer Design](./design.md).

## Use Cases: Real Scenarios with Typocop

### Use Case 1: Impact Analysis

**Scenario**: "I need to change CustomerRepository::save in Magento 2. What will break?"

```
Query: "What breaks if I change CustomerRepository::save?"
Result (single call):
  Confidence: 94%  |  Risk Level: HIGH

  WILL BREAK (5 symbols):
    • AccountManagement::createAccount (Model/AccountManagement.php:89)
    • CustomerPlugin::beforeSave (Plugin/CustomerPlugin.php:23)
    • CreatePost::execute (Controller/Account/CreatePost.php:45)
    • CustomerRepository::getById (Model/ResourceModel/Customer.php:67)
    • CustomerCollection::load (Model/ResourceModel/Customer/Collection.php:34)

  AFFECTED FLOWS (2):
    • CustomerRegistrationFlow (8 steps)
    • CustomerUpdateFlow (5 steps)
```

### Use Case 2: Smart Search

**Scenario**: "Where is the customer authentication logic in this Magento 2 project?"

```
Query: "Where is the customer authentication logic?"
Result (single call):
  Confidence: 92%

  CLUSTERS (2 found):
  1. CustomerLoginFlow (6 symbols, confidence: 95%)
     AccountManagement::authenticate → CustomerRepository::get →
     CustomerPlugin::beforeAuthenticate → SessionManager::start →
     Token::generate → AuditLog::write

  2. CustomerRegistrationFlow (8 symbols, confidence: 91%)
     CreatePost::execute → AccountManagement::createAccount →
     CustomerRepository::save → CustomerResourceModel::save →
     SendWelcomeEmailObserver → EmailSender::send
```

### Use Case 3: 360° Context

**Scenario**: "Tell me everything about CustomerRepository::save."

```
Query: "Tell me everything about CustomerRepository::save"
Result (single call):
  Confidence: 96%

  METHOD: CustomerRepository::save
  Location: Model/CustomerRepository.php:45-78

  CALLED BY (3):
    • AccountManagement::createAccount (Model/AccountManagement.php:89)
    • CustomerPlugin::beforeSave (Plugin/CustomerPlugin.php:23)
    • CreatePost::execute (Controller/Account/CreatePost.php:45)

  CALLS INTO (2):
    • CustomerResourceModel::save (Model/ResourceModel/Customer.php:67)
    • CustomerValidator::validate (Model/Validator/Customer.php:12)

  PART OF (2 flows):
    • CustomerRegistrationFlow (step 4/8)
    • CustomerUpdateFlow (step 3/5)

  CLUSTER: CustomerDataAccess (confidence: 95%)
```

### Use Case 4: Pre-Commit Check

**Scenario**: "I changed 3 files in the Customer module. Is it safe to commit?"

```
Query: "Analyze my uncommitted changes"
Result (single call):
  Confidence: 93%  |  RISK: HIGH

  CHANGED: 9 symbols across 3 files
  IMPACT ANALYSIS:
    ✓ CustomerRegistrationFlow - AFFECTED (4 symbols modified)
    ✓ CustomerUpdateFlow - AFFECTED (2 symbols modified)
    ✓ OrderFlow - OK (no changes)
    ✓ PaymentFlow - OK (no changes)

  RECOMMENDATIONS:
    • Test CustomerRegistrationFlow end-to-end
    • Verify CustomerUpdateFlow integration
    • Review CustomerRepository changes (high coupling via plugins)
```

### Use Case 5: Magento 2 Data Flow Tracing

**Scenario**: "How does a customer registration request flow through Magento 2 to the database?"

```
Query: "Trace data flow from POST /V1/customers to database"
Context: "Magento 2 project"
Result (single call):
  Confidence: 95%  |  Tracing Level: FULL

  ENTRY:
    POST /V1/customers (webapi.xml → CustomerRepositoryInterface::save)

  CONTROLLERS / ACTIONS:
    1. Magento\Customer\Controller\Account\CreatePost::execute()
    2. Magento\Customer\Model\AccountManagement::createAccount()

  PLUGINS (interceptors):
    • CustomerPlugin::beforeSave() (before interceptor)
    • AuditPlugin::afterSave() (after interceptor)

  OBSERVERS:
    • customer_register_success → SendWelcomeEmailObserver

  REPOSITORY LAYER:
    • CustomerRepository::save() → CustomerResourceModel::save()

  MODELS (2 entities):
    • Customer (Model/Customer.php)
    • CustomerCollection (Model/ResourceModel/Customer/Collection.php)

  DATA FLOW:
    REST Request → webapi.xml → AccountManagement →
    CustomerRepository → CustomerResourceModel → Magento ORM → MySQL (customer_entity)
```

### Use Case 6: NestJS Data Flow Tracing

**Scenario**: "How does data flow from POST /api/users/register to the database?"

```
Query: "Trace data flow from POST /api/users/register to database"
Context: "NestJS project with Prisma ORM"
Result (single call):
  Confidence: 97%  |  Tracing Level: FULL

  ENTRY: POST /api/users/register (users.controller.ts:23)
  SERVICES: UsersController.register() → AuthService.createUser() → UserRepository.save()
  MODELS: UserModel (prisma/schema.prisma:45), AuditLog (prisma/schema.prisma:89)
  DATA FLOW: RegisterDTO → AuthService → UserRepository → Prisma Client → PostgreSQL
```

---

## Correctness Properties

*Properties are universal behaviors that must hold across all valid executions. Implemented as property-based tests using [fast-check](https://fast-check.io/).*

### Property 1: Symbol Uniqueness
*For any* set of extracted symbols, all IDs must be unique. **Validates: Req 4.1, 4.3**
```typescript
fc.assert(fc.property(fc.array(symbolArbitrary()), (symbols) => {
  const ids = symbols.map(s => s.id);
  return new Set(ids).size === ids.length;
}));
```

### Property 2: Relationship Validity
*For any* relationship, source and target must reference existing symbol IDs. **Validates: Req 5.5, 5.7**
```typescript
fc.assert(fc.property(symbolListArbitrary(), relationshipListArbitrary(), (symbols, rels) => {
  const ids = new Set(symbols.map(s => s.id));
  return rels.every(r => ids.has(r.source) && ids.has(r.target));
}));
```

### Property 3: Symbol Location Validity
*For any* location, `startLine <= endLine`; on same line, `startColumn <= endColumn`. **Validates: Req 4.4, 4.5**
```typescript
fc.assert(fc.property(locationArbitrary(), (loc) => {
  const lineValid = loc.startLine <= loc.endLine;
  const colValid = loc.startLine < loc.endLine || loc.startColumn <= loc.endColumn;
  return lineValid && colValid;
}));
```

### Property 4: Cluster Confidence Bounds
*For any* cluster, `confidence` must be in `[0.0, 1.0]`. **Validates: Req 6.2**
```typescript
fc.assert(fc.property(clusterArbitrary(), (cluster) =>
  cluster.confidence >= 0.0 && cluster.confidence <= 1.0
));
```

### Property 5: Cluster Minimum Size
*For any* cluster, it must contain at least 2 symbols. **Validates: Req 6.4**
```typescript
fc.assert(fc.property(clusterArbitrary(), (cluster) => cluster.symbols.length >= 2));
```

### Property 6: Cluster Symbol Validity
*For any* cluster, all symbol IDs must reference existing symbols. **Validates: Req 6.5**
```typescript
fc.assert(fc.property(symbolListArbitrary(), clusterArbitrary(), (symbols, cluster) => {
  const ids = new Set(symbols.map(s => s.id));
  return cluster.symbols.every(sid => ids.has(sid));
}));
```

### Property 7: Process Step Ordering
*For any* process, steps must be sequentially ordered with no gaps. **Validates: Req 7.4**
```typescript
fc.assert(fc.property(processArbitrary(), (process) =>
  process.steps.every((step, i) => step.order === i)
));
```

### Property 8: Process Minimum Length
*For any* stored process, it must contain at least 2 steps. **Validates: Req 7.6**
```typescript
fc.assert(fc.property(processArbitrary(), (process) => process.steps.length >= 2));
```

### Property 9: Query Result Limit
*For any* query, returned symbols must not exceed `maxResults`. **Validates: Req 9.6**
```typescript
fc.assert(fc.property(queryArbitrary(), queryResultArbitrary(), (query, result) =>
  result.symbols.length <= query.maxResults
));
```

### Property 10: Query Confidence Bounds
*For any* query result, `confidence` must be in `[0.0, 1.0]`. **Validates: Req 9.4, 21.2**
```typescript
fc.assert(fc.property(queryResultArbitrary(), (result) =>
  result.confidence >= 0.0 && result.confidence <= 1.0
));
```

### Property 11: High Confidence Completeness
*For any* result with `confidence >= 0.90`, at least one symbol must be returned and all IDs must exist in DB. **Validates: Req 9.7, 21.3, 21.4**
```typescript
fc.assert(fc.property(queryResultArbitrary(), symbolDbArbitrary(), (result, db) => {
  if (result.confidence < 0.90) return true;
  const dbIds = new Set(db.map(s => s.id));
  return result.symbols.length > 0 && result.symbols.every(s => dbIds.has(s.id));
}));
```

### Property 12: Risk Level Consistency
*For any* result, risk level must match affected symbol count thresholds. **Validates: Req 10.4–10.7**
```typescript
fc.assert(fc.property(queryResultArbitrary(), (result) => {
  const count = result.symbols.length;
  switch (result.riskLevel) {
    case "low":      return count <= 2;
    case "medium":   return count >= 3 && count <= 10;
    case "high":     return count >= 11;
    case "critical": return containsCoreComponents(result.symbols);
  }
}));
```

### Property 13: Intent Classification Confidence
*For any* classified intent, confidence must be >= 0.7. **Validates: Req 9.2, 21.6, 24.3**
```typescript
fc.assert(fc.property(fc.string({ minLength: 1 }), async (text) => {
  const { confidence } = await classifyIntentWithScore(text);
  return confidence >= 0.7;
}));
```

### Property 14: Embedding Dimensionality
*For any* stored embedding, it must have exactly 3072 dimensions. **Validates: Req 8.3**
```typescript
fc.assert(fc.property(embeddingArbitrary(), (embedding) =>
  embedding.vector.length === 3072 && embedding.dimensions === 3072
));
```

### Property 15: Search Result Ordering
*For any* search results, they must be ordered by descending similarity score. **Validates: Req 17.4**
```typescript
fc.assert(fc.property(fc.array(searchResultArbitrary(), { minLength: 2 }), (results) =>
  results.every((r, i) => i === 0 || results[i - 1].score >= r.score)
));
```

### Property 16: Framework Tracing Completeness
*For any* framework with `tracingLevel === "full"`, traces must include API endpoints, controllers, and DB models. **Validates: Req 13.7, 14.9, 25.3**
```typescript
fc.assert(fc.property(frameworkArbitrary(), processArbitrary(), (framework, process) => {
  if (framework.tracingLevel !== "full") return true;
  return hasAPIEndpoint(process) && hasControllers(process) && hasDBModels(process);
}));
```

### Property 17: Framework Partial Tracing
*For any* framework with `tracingLevel === "partial"`, at least one capability must be enabled. **Validates: Req 14.10, 25.4**
```typescript
fc.assert(fc.property(frameworkArbitrary(), (framework) => {
  if (framework.tracingLevel !== "partial") return true;
  return framework.apiEndpoints || framework.controllers || framework.dbModels;
}));
```

### Property 18: Graph Traversal Depth Limit
*For any* graph traversal, depth must not exceed the configured maximum. **Validates: Req 16.7**
```typescript
fc.assert(fc.property(traversalArbitrary(), fc.nat({ max: 20 }), (traversal, maxDepth) =>
  traversal.depth <= maxDepth
));
```

### Property 19: Input Sanitization
*For any* query, the sanitized form must not contain malicious patterns. **Validates: Req 22.3**
```typescript
fc.assert(fc.property(fc.string(), (query) => {
  const sanitized = sanitizeQuery(query);
  return !containsMaliciousPatterns(sanitized);
}));
```

### Property 20: Path Validation
*For any* valid file path, it must not contain traversal patterns. **Validates: Req 22.4**
```typescript
fc.assert(fc.property(fc.string(), (filePath) => {
  if (!isValidPath(filePath)) return true;
  return !containsTraversalPattern(filePath);
}));
```

### Property 21: Framework Support Invariant
*For any* registered framework: at least one capability enabled; `dbModels` requires non-empty ORMs; `"full"` requires all three capabilities. **Validates: Req 25.1–25.3**
```typescript
fc.assert(fc.property(frameworkArbitrary(), (framework) => {
  const hasAtLeastOne = framework.apiEndpoints || framework.controllers || framework.dbModels;
  const ormValid = !framework.dbModels || framework.supportedORMs.length > 0;
  const fullValid = framework.tracingLevel !== "full" ||
    (framework.apiEndpoints && framework.controllers && framework.dbModels);
  return hasAtLeastOne && ormValid && fullValid;
}));
```
