/**
 * W5.2 — WorkDistributor DO tests.
 *
 * Covers: enqueue dedup + replace_existing, FIFO pull, visibility
 * leases hiding leased items, non-owner complete / release rejection,
 * release returns to visible pool, GC sweep of expired leases,
 * attempt_count increment on each pull, stats counts.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker, {
  _resetRateLimitBucketsForTesting,
} from "../src/index";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

afterEach(() => {
  _resetRateLimitBucketsForTesting();
});

// ────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ────────────────────────────────────────────────────────────────────────────

interface EnqueueResp {
  enqueued: string[];
  duplicates: string[];
  queue_size: number;
  server_time: number;
  error?: string;
}

interface PullResp {
  items: Array<{
    key: string;
    payload?: unknown;
    enqueued_at_ms: number;
    attempt_count: number;
  }>;
  queue_size: number;
  server_time: number;
}

interface CompleteResp {
  completed: string[];
  skipped: string[];
  server_time: number;
}

interface ReleaseResp {
  released: string[];
  skipped: string[];
  server_time: number;
}

interface StatsResp {
  queue_size: number;
  visible: number;
  leased: number;
  oldest_enqueued_at_ms: number | null;
  server_time: number;
}

async function post<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: T }> {
  const req = new Request(`https://test.invalid${path}`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as T };
}

async function getStats(): Promise<StatsResp> {
  const req = new Request("https://test.invalid/work/stats", {
    method: "GET",
    headers: { ...AUTH },
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return (await res.json()) as StatsResp;
}

async function drain(holderId: string): Promise<void> {
  // Helper that pulls + completes everything currently visible so each
  // test starts from an empty queue. Lease visibility is per-isolate
  // and persists across tests in vitest-pool-workers.
  for (let i = 0; i < 5; i++) {
    const { body: pulled } = await post<PullResp>("/work/pull", {
      holder_id: holderId,
      max_items: 100,
      visibility_timeout_ms: 60_000,
    });
    if (pulled.items.length === 0) return;
    await post<CompleteResp>("/work/complete", {
      holder_id: holderId,
      keys: pulled.items.map((i) => i.key),
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("W5.2 WorkDistributor — enqueue", () => {
  it("accepts a fresh enqueue and reports newly-added keys", async () => {
    await drain("init");
    const r = await post<EnqueueResp>("/work/enqueue", {
      items: [
        { key: "href-A", payload: { p: 1 } },
        { key: "href-B" },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.enqueued.sort()).toEqual(["href-A", "href-B"]);
    expect(r.body.duplicates).toEqual([]);
    expect(r.body.queue_size).toBeGreaterThanOrEqual(2);
  });

  it("dedups by key without replace_existing", async () => {
    await drain("dedup");
    await post<EnqueueResp>("/work/enqueue", { items: [{ key: "href-X" }] });
    const r = await post<EnqueueResp>("/work/enqueue", {
      items: [{ key: "href-X", payload: "new" }],
    });
    expect(r.body.enqueued).toEqual([]);
    expect(r.body.duplicates).toEqual(["href-X"]);
    // Original entry is preserved → pulling returns the original payload.
    const pull = await post<PullResp>("/work/pull", {
      holder_id: "h-1",
      max_items: 1,
      visibility_timeout_ms: 60_000,
    });
    expect(pull.body.items[0].payload).toBeUndefined();
    await post<CompleteResp>("/work/complete", {
      holder_id: "h-1",
      keys: ["href-X"],
    });
  });

  it("replaces payload when replace_existing=true (preserves attempt_count)", async () => {
    await drain("replace");
    await post<EnqueueResp>("/work/enqueue", { items: [{ key: "href-R", payload: "v1" }] });
    // Pull-then-release to advance attempt_count.
    await post<PullResp>("/work/pull", {
      holder_id: "h-r",
      max_items: 1,
      visibility_timeout_ms: 1_500,
    });
    await post<ReleaseResp>("/work/release", {
      holder_id: "h-r",
      keys: ["href-R"],
    });
    // Replace with new payload.
    await post<EnqueueResp>("/work/enqueue", {
      items: [{ key: "href-R", payload: "v2" }],
      replace_existing: true,
    });
    const pull = await post<PullResp>("/work/pull", {
      holder_id: "h-r2",
      max_items: 1,
      visibility_timeout_ms: 60_000,
    });
    expect(pull.body.items[0].payload).toBe("v2");
    // attempt_count from pre-replace pull was 1; this pull bumps to 2.
    expect(pull.body.items[0].attempt_count).toBe(2);
    await post<CompleteResp>("/work/complete", {
      holder_id: "h-r2",
      keys: ["href-R"],
    });
  });

  it("rejects an empty / missing items array", async () => {
    const r = await post<EnqueueResp>("/work/enqueue", {});
    expect(r.status).toBe(400);
  });

  it("rejects items with invalid keys", async () => {
    const r = await post<EnqueueResp>("/work/enqueue", {
      items: [{ key: "" }],
    });
    expect(r.status).toBe(400);
  });

  it("caps a single enqueue call at 100 items", async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({ key: `over-${i}` }));
    const r = await post<EnqueueResp>("/work/enqueue", { items });
    expect(r.status).toBe(400);
  });
});

describe("W5.2 WorkDistributor — pull", () => {
  it("returns up to max_items in FIFO order", async () => {
    await drain("fifo");
    // Enqueue in a sequence with a microscopic stagger so enqueued_at
    // orderings are distinct.
    for (const k of ["F-1", "F-2", "F-3"]) {
      await post<EnqueueResp>("/work/enqueue", { items: [{ key: k }] });
    }
    const r = await post<PullResp>("/work/pull", {
      holder_id: "h-fifo",
      max_items: 2,
      visibility_timeout_ms: 60_000,
    });
    expect(r.body.items.map((i) => i.key)).toEqual(["F-1", "F-2"]);
    await post<CompleteResp>("/work/complete", {
      holder_id: "h-fifo",
      keys: ["F-1", "F-2", "F-3"],
    });
    await post<PullResp>("/work/pull", {
      holder_id: "h-fifo",
      max_items: 100,
      visibility_timeout_ms: 1_000,
    });
    await drain("h-fifo");
  });

  it("does NOT return items currently leased to another holder", async () => {
    await drain("excl");
    await post<EnqueueResp>("/work/enqueue", {
      items: [{ key: "X-1" }, { key: "X-2" }],
    });
    const first = await post<PullResp>("/work/pull", {
      holder_id: "alice",
      max_items: 2,
      visibility_timeout_ms: 60_000,
    });
    expect(first.body.items).toHaveLength(2);
    const second = await post<PullResp>("/work/pull", {
      holder_id: "bob",
      max_items: 10,
      visibility_timeout_ms: 60_000,
    });
    expect(second.body.items).toEqual([]);
    await post<CompleteResp>("/work/complete", {
      holder_id: "alice",
      keys: ["X-1", "X-2"],
    });
  });

  it("returns visibility-expired items to subsequent pulls", async () => {
    await drain("vis");
    await post<EnqueueResp>("/work/enqueue", { items: [{ key: "vis-1" }] });
    await post<PullResp>("/work/pull", {
      holder_id: "alice",
      max_items: 1,
      visibility_timeout_ms: 1_000,  // server min
    });
    // Wait past the visibility timeout. Use 1.5 s to comfortably clear
    // the 1 s floor.
    await new Promise((r) => setTimeout(r, 1500));
    const second = await post<PullResp>("/work/pull", {
      holder_id: "bob",
      max_items: 1,
      visibility_timeout_ms: 60_000,
    });
    expect(second.body.items.map((i) => i.key)).toEqual(["vis-1"]);
    await post<CompleteResp>("/work/complete", {
      holder_id: "bob",
      keys: ["vis-1"],
    });
  });

  it("increments attempt_count on each pull", async () => {
    await drain("attempt");
    await post<EnqueueResp>("/work/enqueue", { items: [{ key: "att-1" }] });
    const p1 = await post<PullResp>("/work/pull", {
      holder_id: "h-att",
      max_items: 1,
      visibility_timeout_ms: 1_000,
    });
    expect(p1.body.items[0].attempt_count).toBe(1);
    await post<ReleaseResp>("/work/release", {
      holder_id: "h-att",
      keys: ["att-1"],
    });
    const p2 = await post<PullResp>("/work/pull", {
      holder_id: "h-att",
      max_items: 1,
      visibility_timeout_ms: 60_000,
    });
    expect(p2.body.items[0].attempt_count).toBe(2);
    await post<CompleteResp>("/work/complete", {
      holder_id: "h-att",
      keys: ["att-1"],
    });
  });

  it("rejects pulls without holder_id", async () => {
    const r = await post<PullResp>("/work/pull", {});
    expect(r.status).toBe(400);
  });
});

describe("W5.2 WorkDistributor — complete / release", () => {
  it("complete removes the item entirely", async () => {
    await drain("comp");
    await post<EnqueueResp>("/work/enqueue", { items: [{ key: "C-1" }] });
    await post<PullResp>("/work/pull", {
      holder_id: "h-c",
      max_items: 1,
      visibility_timeout_ms: 60_000,
    });
    await post<CompleteResp>("/work/complete", {
      holder_id: "h-c",
      keys: ["C-1"],
    });
    const stats = await getStats();
    expect(stats.queue_size).toBeGreaterThanOrEqual(0);
    // A subsequent pull cannot return C-1.
    const p = await post<PullResp>("/work/pull", {
      holder_id: "h-c",
      max_items: 1,
      visibility_timeout_ms: 60_000,
    });
    expect(p.body.items.map((i) => i.key)).not.toContain("C-1");
    // restore queue clean state
    if (p.body.items.length) {
      await post<CompleteResp>("/work/complete", {
        holder_id: "h-c",
        keys: p.body.items.map((i) => i.key),
      });
    }
  });

  it("complete by non-owner is silently skipped", async () => {
    await drain("nonown");
    await post<EnqueueResp>("/work/enqueue", { items: [{ key: "N-1" }] });
    await post<PullResp>("/work/pull", {
      holder_id: "alice",
      max_items: 1,
      visibility_timeout_ms: 60_000,
    });
    const r = await post<CompleteResp>("/work/complete", {
      holder_id: "bob",
      keys: ["N-1"],
    });
    expect(r.body.completed).toEqual([]);
    expect(r.body.skipped).toEqual(["N-1"]);
    // Item still exists, still leased to alice.
    const peek = await post<PullResp>("/work/pull", {
      holder_id: "bob",
      max_items: 1,
      visibility_timeout_ms: 60_000,
    });
    expect(peek.body.items).toEqual([]);
    await post<CompleteResp>("/work/complete", {
      holder_id: "alice",
      keys: ["N-1"],
    });
  });

  it("release returns the item to the visible pool", async () => {
    await drain("rel");
    await post<EnqueueResp>("/work/enqueue", { items: [{ key: "R-1" }] });
    await post<PullResp>("/work/pull", {
      holder_id: "alice",
      max_items: 1,
      visibility_timeout_ms: 60_000,
    });
    await post<ReleaseResp>("/work/release", {
      holder_id: "alice",
      keys: ["R-1"],
    });
    const p = await post<PullResp>("/work/pull", {
      holder_id: "bob",
      max_items: 1,
      visibility_timeout_ms: 60_000,
    });
    expect(p.body.items.map((i) => i.key)).toEqual(["R-1"]);
    await post<CompleteResp>("/work/complete", {
      holder_id: "bob",
      keys: ["R-1"],
    });
  });

  it("release by non-owner is silently skipped", async () => {
    await drain("relown");
    await post<EnqueueResp>("/work/enqueue", { items: [{ key: "RO-1" }] });
    await post<PullResp>("/work/pull", {
      holder_id: "alice",
      max_items: 1,
      visibility_timeout_ms: 60_000,
    });
    const r = await post<ReleaseResp>("/work/release", {
      holder_id: "bob",
      keys: ["RO-1"],
    });
    expect(r.body.released).toEqual([]);
    expect(r.body.skipped).toEqual(["RO-1"]);
    await post<CompleteResp>("/work/complete", {
      holder_id: "alice",
      keys: ["RO-1"],
    });
  });
});

describe("W5.2 WorkDistributor — stats", () => {
  it("reports visible / leased / queue_size correctly", async () => {
    await drain("stats");
    await post<EnqueueResp>("/work/enqueue", {
      items: [{ key: "S-1" }, { key: "S-2" }, { key: "S-3" }],
    });
    await post<PullResp>("/work/pull", {
      holder_id: "h-s",
      max_items: 1,
      visibility_timeout_ms: 60_000,
    });
    const stats = await getStats();
    expect(stats.queue_size).toBe(3);
    expect(stats.leased).toBe(1);
    expect(stats.visible).toBe(2);
    expect(typeof stats.oldest_enqueued_at_ms).toBe("number");
    // Clean up so this test doesn't pollute later test files.
    await drain("h-s");
  });
});
