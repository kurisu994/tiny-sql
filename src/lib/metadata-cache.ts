import type { DriverKind } from "@/lib/tauri-api";

export type MetadataResource =
  | "schemas"
  | "tables"
  | "columns"
  | "indexes"
  | "constraints";

/** metadata cache 的完整分区键，禁止省略 connection/driver/schema 边界。 */
export interface MetadataCacheKey {
  connectionId: string;
  driver: DriverKind;
  database: string;
  schema: string | null;
  resource: MetadataResource;
  table?: string | null;
}

interface CacheEntry {
  key: MetadataCacheKey;
  value: unknown;
  expiresAt: number;
}

/**
 * schema 元数据的内存 LRU cache。
 *
 * cache 不持久化，连接边界和数据库方言都进入 key；读取命中时会提升为最近使用项。
 */
export class MetadataCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly maxEntries = 128,
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {
    if (maxEntries < 1) throw new Error("metadata cache 容量必须大于 0");
    if (ttlMs < 1) throw new Error("metadata cache TTL 必须大于 0");
  }

  get<T>(key: MetadataCacheKey): T | undefined {
    const encoded = encodeKey(key);
    const entry = this.entries.get(encoded);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(encoded);
      return undefined;
    }
    this.entries.delete(encoded);
    this.entries.set(encoded, entry);
    return entry.value as T;
  }

  set<T>(key: MetadataCacheKey, value: T): void {
    const encoded = encodeKey(key);
    this.entries.delete(encoded);
    this.entries.set(encoded, {
      key: { ...key, table: key.table ?? null },
      value,
      expiresAt: this.now() + this.ttlMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** 失效一个连接下的全部 metadata。 */
  clearConnection(connectionId: string): void {
    this.deleteWhere((key) => key.connectionId === connectionId);
  }

  /** 失效一个 database/schema 分区；schema 省略时覆盖该 database 的所有 schema。 */
  invalidateScope(input: {
    connectionId: string;
    driver: DriverKind;
    database: string;
    schema?: string | null;
  }): void {
    this.deleteWhere(
      (key) =>
        key.connectionId === input.connectionId &&
        key.driver === input.driver &&
        key.database === input.database &&
        (input.schema === undefined || key.schema === input.schema),
    );
  }

  clear(): void {
    this.entries.clear();
  }

  /** 仅用于测试和诊断 cache 上限。 */
  get size(): number {
    return this.entries.size;
  }

  private deleteWhere(predicate: (key: MetadataCacheKey) => boolean): void {
    for (const [encoded, entry] of this.entries) {
      if (predicate(entry.key)) this.entries.delete(encoded);
    }
  }
}

function encodeKey(key: MetadataCacheKey): string {
  return JSON.stringify([
    key.connectionId,
    key.driver,
    key.database,
    key.schema,
    key.resource,
    key.table ?? null,
  ]);
}

export const metadataCache = new MetadataCache();
