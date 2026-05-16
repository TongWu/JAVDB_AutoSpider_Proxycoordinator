/**
 * Phase 2 / ADR-002 — shared retention sweep for the five history tables.
 *
 * Each history-bearing DO calls this helper inside its GC alarm to drop
 * rows older than `retentionMs` and to enforce a hard `maxRows` ceiling
 * (defence-in-depth against unbounded growth if retention is misconfigured).
 *
 * Strategy:
 *   1. Age sweep — DELETE WHERE ts < (now - retentionMs).
 *      Skipped when retentionMs <= 0 (debug / disable mode).
 *   2. Row-count sweep — if remaining rows > maxRows, drop the oldest
 *      (rowcount - maxRows) rows in one DELETE.
 *
 * Pass the wall-clock `now` so tests can control timing without depending
 * on `Date.now()`.
 *
 * The `tableName` argument is interpolated directly into SQL; callers must
 * pass a hard-coded literal, NEVER user input.
 */
export function pruneLogTable(
  sql: SqlStorage,
  tableName: string,
  retentionMs: number,
  maxRows: number,
  nowMs: number,
): void {
  if (retentionMs > 0) {
    const cutoff = nowMs - retentionMs;
    sql.exec(`DELETE FROM ${tableName} WHERE ts < ?`, cutoff);
  }
  if (maxRows > 0) {
    const countRow = sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${tableName}`,
    ).one();
    const excess = countRow.n - maxRows;
    if (excess > 0) {
      sql.exec(
        `DELETE FROM ${tableName} WHERE ts IN (
           SELECT ts FROM ${tableName} ORDER BY ts ASC LIMIT ?
         )`,
        excess,
      );
    }
  }
}
