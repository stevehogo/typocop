import { vi } from "vitest";

interface FakeServerRecord {
  readonly implementations: Map<string, Record<string, (...args: any[]) => any>>;
}

declare global {
  var __ladybugGrpcMock:
    | {
      readonly servers: Map<string, FakeServerRecord>;
    }
    | undefined;
}

export function createProtoLoaderMock(): { readonly loadSync: ReturnType<typeof vi.fn> } {
  class BaseClient {
    static service = { serviceName: "Base" };

    constructor(protected readonly address: string) {}

    waitForReady(deadline: Date, callback: (error?: Error | null) => void): void {
      const grpcModule = globalThis.__ladybugGrpcMock;
      if (grpcModule?.servers.has(this.address)) {
        callback(null);
        return;
      }
      callback(
        Object.assign(new Error(`Server ${this.address} unavailable before ${deadline.toISOString()}`), {
          code: 14,
        }),
      );
    }

    close(): void {}

    protected invoke(
      serviceName: string,
      method: string,
      request: unknown,
      metadata: { get: (key: string) => string[] },
      callback: (error: Error | null, response?: unknown) => void,
    ): void {
      const grpcModule = globalThis.__ladybugGrpcMock;
      const server = grpcModule?.servers.get(this.address);
      if (!server) {
        callback(Object.assign(new Error(`Server ${this.address} unavailable`), { code: 14 }));
        return;
      }

      const implementation = server.implementations.get(serviceName);
      const handler = implementation?.[method];
      if (typeof handler !== "function") {
        callback(Object.assign(new Error(`${serviceName}.${method} unavailable`), { code: 13 }));
        return;
      }

      void handler({ request, metadata }, callback);
    }
  }

  class FakeHealthClient extends BaseClient {
    static service = { serviceName: "Health" };

    Check(
      request: unknown,
      metadata: { get: (key: string) => string[] },
      _options: unknown,
      callback: (error: Error | null, response?: unknown) => void,
    ): void {
      this.invoke("Health", "Check", request, metadata, callback);
    }
  }

  class FakeAdminClient extends BaseClient {
    static service = { serviceName: "Admin" };

    GetMetrics(
      request: unknown,
      metadata: { get: (key: string) => string[] },
      _options: unknown,
      callback: (error: Error | null, response?: unknown) => void,
    ): void {
      this.invoke("Admin", "GetMetrics", request, metadata, callback);
    }

    Shutdown(
      request: unknown,
      metadata: { get: (key: string) => string[] },
      _options: unknown,
      callback: (error: Error | null, response?: unknown) => void,
    ): void {
      this.invoke("Admin", "Shutdown", request, metadata, callback);
    }
  }

  class FakeGraphClient extends BaseClient {
    static service = { serviceName: "Graph" };

    QueryNodes(request: unknown, metadata: { get: (key: string) => string[] }, _options: unknown, callback: (error: Error | null, response?: unknown) => void): void {
      this.invoke("Graph", "QueryNodes", request, metadata, callback);
    }

    QueryRelationships(request: unknown, metadata: { get: (key: string) => string[] }, _options: unknown, callback: (error: Error | null, response?: unknown) => void): void {
      this.invoke("Graph", "QueryRelationships", request, metadata, callback);
    }

    RunCypher(request: unknown, metadata: { get: (key: string) => string[] }, _options: unknown, callback: (error: Error | null, response?: unknown) => void): void {
      this.invoke("Graph", "RunCypher", request, metadata, callback);
    }

    RunCypherWrite(request: unknown, metadata: { get: (key: string) => string[] }, _options: unknown, callback: (error: Error | null, response?: unknown) => void): void {
      this.invoke("Graph", "RunCypherWrite", request, metadata, callback);
    }

    CreateNode(request: unknown, metadata: { get: (key: string) => string[] }, _options: unknown, callback: (error: Error | null, response?: unknown) => void): void {
      this.invoke("Graph", "CreateNode", request, metadata, callback);
    }

    CreateRelationship(request: unknown, metadata: { get: (key: string) => string[] }, _options: unknown, callback: (error: Error | null, response?: unknown) => void): void {
      this.invoke("Graph", "CreateRelationship", request, metadata, callback);
    }

    CreateNodes(request: unknown, metadata: { get: (key: string) => string[] }, _options: unknown, callback: (error: Error | null, response?: unknown) => void): void {
      this.invoke("Graph", "CreateNodes", request, metadata, callback);
    }

    CreateRelationships(request: unknown, metadata: { get: (key: string) => string[] }, _options: unknown, callback: (error: Error | null, response?: unknown) => void): void {
      this.invoke("Graph", "CreateRelationships", request, metadata, callback);
    }

    DeleteNodesByLabel(request: unknown, metadata: { get: (key: string) => string[] }, _options: unknown, callback: (error: Error | null, response?: unknown) => void): void {
      this.invoke("Graph", "DeleteNodesByLabel", request, metadata, callback);
    }

    DeleteRelationshipsByType(request: unknown, metadata: { get: (key: string) => string[] }, _options: unknown, callback: (error: Error | null, response?: unknown) => void): void {
      this.invoke("Graph", "DeleteRelationshipsByType", request, metadata, callback);
    }
  }

  class FakeVectorClient extends BaseClient {
    static service = { serviceName: "Vector" };

    CreateTables(request: unknown, metadata: { get: (key: string) => string[] }, _options: unknown, callback: (error: Error | null, response?: unknown) => void): void {
      this.invoke("Vector", "CreateTables", request, metadata, callback);
    }

    IndexSymbol(request: unknown, metadata: { get: (key: string) => string[] }, _options: unknown, callback: (error: Error | null, response?: unknown) => void): void {
      this.invoke("Vector", "IndexSymbol", request, metadata, callback);
    }

    IndexSymbols(request: unknown, metadata: { get: (key: string) => string[] }, _options: unknown, callback: (error: Error | null, response?: unknown) => void): void {
      this.invoke("Vector", "IndexSymbols", request, metadata, callback);
    }

    SemanticSearch(request: unknown, metadata: { get: (key: string) => string[] }, _options: unknown, callback: (error: Error | null, response?: unknown) => void): void {
      this.invoke("Vector", "SemanticSearch", request, metadata, callback);
    }

    DeleteAll(request: unknown, metadata: { get: (key: string) => string[] }, _options: unknown, callback: (error: Error | null, response?: unknown) => void): void {
      this.invoke("Vector", "DeleteAll", request, metadata, callback);
    }
  }

  return {
    loadSync: vi.fn(() => ({
      typocop: {
        ladybug: {
          v1: {
            Health: FakeHealthClient,
            Admin: FakeAdminClient,
            Graph: FakeGraphClient,
            Vector: FakeVectorClient,
          },
        },
      },
    })),
  };
}

export function createGrpcJsMock(): Record<string, unknown> {
  const servers = new Map<string, FakeServer>();

  class Metadata {
    private readonly values = new Map<string, string[]>();

    set(key: string, value: string): void {
      this.values.set(key, [value]);
    }

    get(key: string): string[] {
      return this.values.get(key) || [];
    }
  }

  class FakeServer {
    readonly implementations = new Map<string, Record<string, (...args: any[]) => any>>();
    private address = "";

    constructor(public readonly options?: unknown) {}

    addService(definition: { readonly serviceName?: string }, implementation: Record<string, (...args: any[]) => any>): void {
      const name = definition.serviceName ?? `service-${this.implementations.size}`;
      this.implementations.set(name, implementation);
    }

    bindAsync(address: string, _credentials: unknown, callback: (error: Error | null) => void): void {
      this.address = address;
      servers.set(address, this);
      callback(null);
    }

    start(): void {}

    tryShutdown(callback: () => void): void {
      servers.delete(this.address);
      callback();
    }

    forceShutdown(): void {
      servers.delete(this.address);
    }
  }

  const api = {
    status: {
      INVALID_ARGUMENT: 3,
      DEADLINE_EXCEEDED: 4,
      RESOURCE_EXHAUSTED: 8,
      INTERNAL: 13,
      UNAVAILABLE: 14,
      UNAUTHENTICATED: 16,
    },
    Metadata,
    credentials: {
      createInsecure: () => ({}),
    },
    Server: FakeServer,
    ServerCredentials: {
      createInsecure: () => ({}),
    },
    loadPackageDefinition: (definition: unknown) => definition,
    __getServer: (address: string) => servers.get(address),
    __clearServers: () => servers.clear(),
    servers,
  };

  globalThis.__ladybugGrpcMock = api as unknown as {
    readonly servers: Map<string, FakeServerRecord>;
  };

  return api;
}
