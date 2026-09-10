declare module "neo4j-driver" {
  export const auth: {
    basic(username: string, password: string): unknown;
  };

  export function driver(uri: string, authToken: unknown): {
    executeQuery<T = Record<string, unknown>>(
      query: string,
      parameters?: Record<string, unknown>,
      config?: { database?: string }
    ): Promise<{ records: Array<{ get(key: keyof T | string): unknown }> }>;
    verifyConnectivity(): Promise<void>;
    close(): Promise<void>;
  };

  export function int(value: number): unknown;
}
