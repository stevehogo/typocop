declare module "@grpc/grpc-js" {
  export const status: Record<string, number>;
  export class Metadata {
    set(key: string, value: string): void;
    get(key: string): string[];
  }
  export interface CallOptions {
    deadline?: Date | number;
  }
  export type ChannelCredentials = unknown;
  export type ClientOptions = Record<string, unknown>;
  export class Client {
    constructor(
      address: string,
      credentials: ChannelCredentials,
      options?: ClientOptions,
    );
    close(): void;
    waitForReady(
      deadline: Date,
      callback: (error?: Error | null) => void,
    ): void;
  }
  export const credentials: {
    createInsecure(): ChannelCredentials;
  };
  export class Server {
    constructor(options?: Record<string, unknown>);
    addService(service: unknown, implementation: Record<string, unknown>): void;
    bindAsync(
      address: string,
      credentials: unknown,
      callback: (error: Error | null, port?: number) => void,
    ): void;
    start(): void;
    tryShutdown(callback: () => void): void;
    forceShutdown(): void;
  }

  export const ServerCredentials: {
    createInsecure(): unknown;
  };

  export function loadPackageDefinition(definition: unknown): unknown;
}

declare module "@grpc/proto-loader" {
  export function loadSync(
    filename: string,
    options?: Record<string, unknown>,
  ): unknown;
}
