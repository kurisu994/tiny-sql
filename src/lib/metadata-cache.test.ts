import { describe, expect, it } from "vitest";

import {
  MetadataCache,
  type MetadataCacheKey,
} from "@/lib/metadata-cache";

function key(
  database: string,
  resource: MetadataCacheKey["resource"] = "tables",
): MetadataCacheKey {
  return {
    connectionId: "c1",
    driver: "mysql",
    database,
    schema: null,
    resource,
    table: resource === "columns" ? "users" : null,
  };
}

describe("MetadataCache", () => {
  it("按最近访问顺序淘汰最旧项", () => {
    const cache = new MetadataCache(2, 1000);
    cache.set(key("a"), ["a"]);
    cache.set(key("b"), ["b"]);
    expect(cache.get(key("a"))).toEqual(["a"]);

    cache.set(key("c"), ["c"]);

    expect(cache.get(key("b"))).toBeUndefined();
    expect(cache.get(key("a"))).toEqual(["a"]);
    expect(cache.get(key("c"))).toEqual(["c"]);
  });

  it("TTL 到期后不再返回旧值", () => {
    let now = 100;
    const cache = new MetadataCache(2, 50, () => now);
    cache.set(key("app"), ["users"]);
    now = 149;
    expect(cache.get(key("app"))).toEqual(["users"]);
    now = 150;
    expect(cache.get(key("app"))).toBeUndefined();
  });

  it("按 connection/driver/database/schema 精确失效", () => {
    const cache = new MetadataCache();
    const publicKey: MetadataCacheKey = {
      connectionId: "c1",
      driver: "postgresql",
      database: "app",
      schema: "public",
      resource: "tables",
    };
    const auditKey = { ...publicKey, schema: "audit" };
    const otherConnectionKey = { ...publicKey, connectionId: "c2" };
    cache.set(publicKey, ["users"]);
    cache.set(auditKey, ["events"]);
    cache.set(otherConnectionKey, ["users"]);

    cache.invalidateScope({
      connectionId: "c1",
      driver: "postgresql",
      database: "app",
      schema: "public",
    });

    expect(cache.get(publicKey)).toBeUndefined();
    expect(cache.get(auditKey)).toEqual(["events"]);
    expect(cache.get(otherConnectionKey)).toEqual(["users"]);
  });

  it("大 schema 写入始终受 LRU 容量约束", () => {
    const cache = new MetadataCache(128, 1000);
    for (let index = 0; index < 5000; index += 1) {
      cache.set(key(`database_${index}`), [`table_${index}`]);
    }

    expect(cache.size).toBe(128);
    expect(cache.get(key("database_0"))).toBeUndefined();
    expect(cache.get(key("database_4999"))).toEqual(["table_4999"]);
  });
});
