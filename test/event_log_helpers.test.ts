import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { pruneLogTable } from "../src/event_log_helpers";

describe("pruneLogTable", () => {
  // We exercise pruneLogTable via the existing GlobalLoginState DO's storage
  // sql binding to avoid building a throwaway DO just for this helper.
  it("deletes rows older than retentionMs", async () => {
    const id = env.GLOBAL_LOGIN_STATE_DO.idFromName("prune-test-1");
    const stub = env.GLOBAL_LOGIN_STATE_DO.get(id);

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS test_log (ts INTEGER PRIMARY KEY, msg TEXT)",
      );
      sql.exec("DELETE FROM test_log");
      sql.exec("INSERT INTO test_log VALUES (1000, 'old')");
      sql.exec("INSERT INTO test_log VALUES (5000, 'new')");

      // Retention = 2000ms. Rows where ts < now - 2000 = 5000 - 2000 = 3000
      // should be deleted. So row at ts=1000 is dropped, row at ts=5000 stays.
      pruneLogTable(sql, "test_log", 2000, 100, 5000);

      const remaining = Array.from(
        sql.exec<{ ts: number }>("SELECT ts FROM test_log ORDER BY ts"),
      );
      expect(remaining.map((r) => r.ts)).toEqual([5000]);
    });
  });

  it("enforces maxRows hard cap by dropping oldest", async () => {
    const id = env.GLOBAL_LOGIN_STATE_DO.idFromName("prune-test-2");
    const stub = env.GLOBAL_LOGIN_STATE_DO.get(id);

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS test_log (ts INTEGER PRIMARY KEY, msg TEXT)");
      sql.exec("DELETE FROM test_log");
      for (let i = 1; i <= 10; i++) {
        sql.exec("INSERT INTO test_log VALUES (?, ?)", i * 1000, `r${i}`);
      }

      // No age-based prune (retention very large); cap = 3 rows. Should
      // keep the 3 newest (ts=8000, 9000, 10000).
      pruneLogTable(sql, "test_log", 100_000_000, 3, 10_000);

      const remaining = Array.from(
        sql.exec<{ ts: number }>("SELECT ts FROM test_log ORDER BY ts"),
      );
      expect(remaining.map((r) => r.ts)).toEqual([8000, 9000, 10000]);
    });
  });

  it("retentionMs=0 disables age-based sweep", async () => {
    const id = env.GLOBAL_LOGIN_STATE_DO.idFromName("prune-test-3");
    const stub = env.GLOBAL_LOGIN_STATE_DO.get(id);

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS test_log (ts INTEGER PRIMARY KEY, msg TEXT)");
      sql.exec("DELETE FROM test_log");
      sql.exec("INSERT INTO test_log VALUES (1, 'ancient')");

      pruneLogTable(sql, "test_log", 0, 100, 1_000_000_000);

      const remaining = Array.from(
        sql.exec<{ ts: number }>("SELECT ts FROM test_log"),
      );
      expect(remaining).toHaveLength(1);
    });
  });

  it("does not error when called on an empty table", async () => {
    const id = env.GLOBAL_LOGIN_STATE_DO.idFromName("prune-empty");
    const stub = env.GLOBAL_LOGIN_STATE_DO.get(id);
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS empty_log (ts INTEGER PRIMARY KEY)");
      sql.exec("DELETE FROM empty_log");
      pruneLogTable(sql, "empty_log", 1000, 100, 5000);
      const count = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM empty_log").one().n;
      expect(count).toBe(0);
    });
  });
});
