import {
  ClaimMovieRequest,
  ClaimMovieResponse,
  CompleteMovieRequest,
  CompleteMovieResponse,
  DEFAULT_MOVIE_CLAIM_TTL_MS,
  Env,
  MOVIE_CLAIM_ALARM_INTERVAL_MS,
  MOVIE_CLAIM_COOLDOWN_LADDER_MS,
  MOVIE_CLAIM_DEAD_LETTER_THRESHOLD,
  MOVIE_CLAIM_FAILURE_TTL_MS,
  MOVIE_CLAIM_TTL_MAX_MS,
  MOVIE_CLAIM_TTL_MIN_MS,
  MovieStatusResponse,
  ReleaseMovieRequest,
  ReleaseMovieResponse,
  ReportFailureRequest,
  ReportFailureResponse,
} from "./types";

/**
 * MovieClaimState — per-day-sharded DO that arbitrates JavDB detail-page
 * fetches across multiple GH Actions runners (P1-B).
 *
 * Addressed by ``idFromName("YYYY-MM-DD-Asia/Singapore")`` from
 * {@link forwardToMovieClaimDo} in {@link ./index.ts}.  A single shard holds
 * all claims for a given operational day, so:
 *   - SQLite footprint stays bounded (a day has at most a few thousand
 *     details, not a year's worth);
 *   - Old shards naturally evict via the Cloudflare DO LRU once they go
 *     untouched, no explicit cleanup required;
 *   - Cross-day races are impossible by construction (the shard ID is the
 *     mutex), removing the need for a global "movie has ever been seen"
 *     index that would never fit in a single DO.
 *
 * State machine (single-key snapshot in DO storage; mirrors `ProxyCoordinator`
 * with an in-memory ``cached`` layer):
 *
 *   - `claims[href]` → ``{ holder_id, claimed_at, expires_at }`` for in-flight work.
 *   - `completed`    → array of hrefs already gone through ``complete_movie``.
 *
 * GC: a DO Alarm fires every {@link MOVIE_CLAIM_ALARM_INTERVAL_MS} (10 min)
 * to prune ``claims`` entries whose ``expires_at <= now``, so a runner that
 * crashes mid-fetch doesn't permanently lock the movie.  The Alarm
 * intentionally does NOT prune ``completed`` — completions are the *outcome*
 * we want preserved across the day; the per-day shard already provides
 * eventual cleanup.
 *
 * All write paths refresh ``cached`` immediately (same pattern as
 * {@link proxy_coordinator.ts}'s ``persistState``).
 */

interface MovieClaim {
  holder_id: string;
  claimed_at: number;
  expires_at: number;
}

/** P2-A — per-href failure / cooldown bookkeeping.  Lives next to the
 *  per-href claim record so a ``claim_movie`` can short-circuit on
 *  ``next_attempt_at > now`` without consulting a separate map. */
interface MovieFailure {
  fail_count: number;
  /** Wall-clock ms epoch of the most recent failure (drives the
   *  failure-record TTL prune in `pruneStaleFailures`). */
  last_failure_at: number;
  /** Wall-clock ms epoch the runner may retry the href after.  Computed
   *  from {@link MOVIE_CLAIM_COOLDOWN_LADDER_MS} and the new fail_count. */
  next_attempt_at: number;
  /** Free-form error tag stored for ops only; DO never reads it. */
  last_error_kind: string;
}

interface MovieClaimData {
  /** Active per-href claims keyed by movie detail href. */
  claims: Record<string, MovieClaim>;
  /**
   * Hrefs that have already completed within this shard.  Stored as a plain
   * array (not a Set) to round-trip cleanly through DO storage; we de-dupe
   * via {@link Array.includes} at the few mutation points so repeated
   * completes are idempotent.
   */
  completed: string[];
  /** P2-A — per-href failure stats; ``undefined`` (legacy) when this
   *  shard predates the P2-A schema bump.  We initialise the field on
   *  read to keep the on-disk migration zero-cost. */
  failures?: Record<string, MovieFailure>;
}

const STORAGE_KEY = "state";

export class MovieClaimState implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  /**
   * In-memory snapshot mirror.  Same caveats as
   * `ProxyCoordinator.cached`: every write path MUST refresh this before
   * returning, otherwise reads from the same DO instance could observe a
   * stale view.  Initialised lazily on first access.
   */
  private cached: MovieClaimData | null = null;
  /** Tracks whether the periodic alarm is already scheduled, so we don't
   *  thrash `setAlarm` on every request. */
  private alarmScheduled: boolean = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/do/claim_movie":
          return await this.handleClaim(request);
        case "/do/release_movie":
          return await this.handleRelease(request);
        case "/do/complete_movie":
          return await this.handleComplete(request);
        case "/do/report_failure":
          return await this.handleReportFailure(request);
        case "/do/movie_status":
          return await this.handleStatus(url);
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: message }, 500);
    }
  }

  /**
   * DO Alarm — fires every {@link MOVIE_CLAIM_ALARM_INTERVAL_MS} to GC
   * expired claims.  Cloudflare invokes this independently of inbound
   * requests, so a shard with crashed claim holders still recovers without
   * waiting for the next request.
   */
  async alarm(): Promise<void> {
    const data = await this.loadState();
    const now = Date.now();
    let purged = 0;
    for (const href of Object.keys(data.claims)) {
      if (data.claims[href].expires_at <= now) {
        delete data.claims[href];
        purged += 1;
      }
    }
    // P2-A — also age out failure records whose last failure is older
    // than `MOVIE_CLAIM_FAILURE_TTL_MS`.  This is cheap (handful of
    // entries per shard) and keeps the shard's footprint bounded even
    // if a workflow run lasts > 24h (e.g. a stuck cron).
    if (data.failures) {
      for (const href of Object.keys(data.failures)) {
        if (data.failures[href].last_failure_at <= now - MOVIE_CLAIM_FAILURE_TTL_MS) {
          delete data.failures[href];
          purged += 1;
        }
      }
    }
    if (purged > 0) {
      await this.persistState(data);
    }
    // Re-arm only when the shard still has live state to track; an idle
    // shard stops costing alarm invocations until the next claim arrives.
    const hasLiveState =
      Object.keys(data.claims).length > 0 ||
      (data.failures !== undefined && Object.keys(data.failures).length > 0);
    if (hasLiveState) {
      await this.scheduleAlarm();
    } else {
      this.alarmScheduled = false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Endpoint handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleClaim(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<ClaimMovieRequest>;
    const href = String(body.href ?? "").trim();
    const holderId = String(body.holder_id ?? "").trim();
    if (!href || !holderId) {
      return jsonResponse({ error: "missing href or holder_id" }, 400);
    }
    const ttlMs = clampTtlMs(Number(body.ttl_ms ?? 0));

    const now = Date.now();
    const data = await this.loadState();
    const failure = data.failures?.[href];

    // Already completed inside this shard → never re-claim, surface to caller
    // so they can short-circuit + mark their local history.
    if (data.completed.includes(href)) {
      const response: ClaimMovieResponse = {
        acquired: false,
        current_holder_id: "",
        expires_at: 0,
        already_completed: true,
        cooldown_until: 0,
        server_time: now,
      };
      return jsonResponse(response);
    }

    // P2-A — refuse acquire while the href is in cooldown after recent
    // failures.  We DO NOT touch the claim slot (so a peer holder mid-fetch
    // is preserved) and we DO NOT touch the failure record (so the
    // cooldown elapses naturally).  The caller observes acquired=false +
    // a positive cooldown_until and backs off.
    if (failure && failure.next_attempt_at > now) {
      const response: ClaimMovieResponse = {
        acquired: false,
        current_holder_id: "",
        expires_at: 0,
        already_completed: false,
        cooldown_until: failure.next_attempt_at,
        last_error_kind: failure.last_error_kind,
        fail_count: failure.fail_count,
        server_time: now,
      };
      return jsonResponse(response);
    }

    const existing = data.claims[href] ?? null;
    const claimExpired = existing === null || now >= existing.expires_at;
    const sameHolder = existing !== null && existing.holder_id === holderId;

    let acquired = false;
    if (claimExpired || sameHolder) {
      // Fresh acquire (no claim / expired) OR idempotent renewal by the
      // current holder.  Both write the new expiry/claimed_at.
      data.claims[href] = {
        holder_id: holderId,
        claimed_at: existing && sameHolder ? existing.claimed_at : now,
        expires_at: now + ttlMs,
      };
      await this.persistState(data);
      acquired = true;
      // Make sure the GC alarm is armed so a crashed holder doesn't lock
      // the href until the next claim arrives.
      await this.scheduleAlarm();
    }

    const winning = data.claims[href];
    const response: ClaimMovieResponse = {
      acquired,
      current_holder_id: winning?.holder_id ?? "",
      expires_at: winning?.expires_at ?? 0,
      already_completed: false,
      // Surface failure metadata even when ``acquired=true`` (a renewal
      // mid-failure-window) so ops can see the history without
      // hitting /movie_status separately.
      cooldown_until: failure?.next_attempt_at ?? 0,
      last_error_kind: failure?.last_error_kind ?? "",
      fail_count: failure?.fail_count ?? 0,
      server_time: now,
    };
    return jsonResponse(response);
  }

  private async handleRelease(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<ReleaseMovieRequest>;
    const href = String(body.href ?? "").trim();
    const holderId = String(body.holder_id ?? "").trim();
    if (!href || !holderId) {
      return jsonResponse({ error: "missing href or holder_id" }, 400);
    }

    const now = Date.now();
    const data = await this.loadState();

    let released = false;
    const existing = data.claims[href];
    if (existing && existing.holder_id === holderId) {
      delete data.claims[href];
      await this.persistState(data);
      released = true;
    }
    // Non-owner releases are silently ignored to match `release_lease`'s
    // fail-open semantics.

    const response: ReleaseMovieResponse = {
      released,
      server_time: now,
    };
    return jsonResponse(response);
  }

  private async handleComplete(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<CompleteMovieRequest>;
    const href = String(body.href ?? "").trim();
    const holderId = String(body.holder_id ?? "").trim();
    if (!href || !holderId) {
      return jsonResponse({ error: "missing href or holder_id" }, 400);
    }

    const now = Date.now();
    const data = await this.loadState();

    let completed = false;
    const existing = data.claims[href];
    // If already completed, treat as success (idempotent) so a retried
    // ``complete_movie`` from a network blip never raises an error.
    if (data.completed.includes(href)) {
      completed = true;
    } else if (existing && existing.holder_id === holderId) {
      delete data.claims[href];
      data.completed.push(href);
      // P2-A — a successful complete wipes the failure / cooldown
      // record so the next re-ingestion (different shard date, or a
      // forced retry) starts from a clean slate.
      if (data.failures && data.failures[href]) {
        delete data.failures[href];
      }
      await this.persistState(data);
      completed = true;
    }
    // Stale-holder complete (the entry no longer exists or belongs to
    // someone else): completed=false; caller must decide whether to retry.

    const response: CompleteMovieResponse = {
      completed,
      href,
      server_time: now,
    };
    return jsonResponse(response);
  }

  /**
   * P2-A — record a per-href failure and bump its cooldown.
   *
   * The DO computes ``next_attempt_at`` from the new ``fail_count``
   * via {@link MOVIE_CLAIM_COOLDOWN_LADDER_MS}; once
   * ``fail_count >= MOVIE_CLAIM_DEAD_LETTER_THRESHOLD`` the cooldown is
   * pinned at the maximum so the href is dead-lettered for the rest of
   * the shard's lifetime (i.e. until the per-day shard rotates).
   *
   * Calls also release the active claim if the reporting holder still
   * owns it — releasing on failure is symmetric with the runner's own
   * cleanup so peers can immediately observe the slot as free.
   */
  private async handleReportFailure(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<ReportFailureRequest>;
    const href = String(body.href ?? "").trim();
    if (!href) {
      return jsonResponse({ error: "missing href" }, 400);
    }
    const holderId = String(body.holder_id ?? "").trim();
    const errorKind = clipShortString(String(body.error_kind ?? "").trim());

    const now = Date.now();
    const data = await this.loadState();
    if (!data.failures) data.failures = {};

    const prior = data.failures[href];
    const failCount = (prior?.fail_count ?? 0) + 1;

    // Cooldown override from caller wins when present (within bounds);
    // otherwise apply the ladder.
    let cooldown: number;
    if (
      typeof body.cooldown_ms === "number" &&
      Number.isFinite(body.cooldown_ms) &&
      body.cooldown_ms > 0
    ) {
      cooldown = Math.min(body.cooldown_ms, lastLadderMs());
    } else {
      cooldown = computeCooldownMs(failCount);
    }
    const nextAttemptAt = now + cooldown;
    const deadLettered = failCount >= MOVIE_CLAIM_DEAD_LETTER_THRESHOLD;

    data.failures[href] = {
      fail_count: failCount,
      last_failure_at: now,
      next_attempt_at: nextAttemptAt,
      last_error_kind: errorKind,
    };

    // Release the active claim if the reporting holder still owns it.
    // This mirrors the symmetric "complete on success / release on
    // failure" contract — without it a buggy holder would have to
    // re-call ``release_movie`` separately to free the slot.
    if (
      holderId &&
      data.claims[href] !== undefined &&
      data.claims[href].holder_id === holderId
    ) {
      delete data.claims[href];
    }

    await this.persistState(data);
    await this.scheduleAlarm();

    const response: ReportFailureResponse = {
      fail_count: failCount,
      cooldown_until: nextAttemptAt,
      dead_lettered: deadLettered,
      server_time: now,
    };
    return jsonResponse(response);
  }

  private async handleStatus(url: URL): Promise<Response> {
    const href = (url.searchParams.get("href") ?? "").trim();
    if (!href) {
      return jsonResponse({ error: "missing href" }, 400);
    }
    const now = Date.now();
    const data = await this.loadState();
    const existing = data.claims[href] ?? null;
    const failure = data.failures?.[href] ?? null;
    const response: MovieStatusResponse = {
      current_holder_id: existing?.holder_id ?? null,
      expires_at: existing?.expires_at ?? 0,
      already_completed: data.completed.includes(href),
      cooldown_until: failure?.next_attempt_at ?? 0,
      last_error_kind: failure?.last_error_kind ?? "",
      fail_count: failure?.fail_count ?? 0,
      server_time: now,
    };
    return jsonResponse(response);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Storage helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async loadState(): Promise<MovieClaimData> {
    if (this.cached !== null) return this.cached;
    const stored = (await this.state.storage.get<MovieClaimData>(STORAGE_KEY)) ?? null;
    const data: MovieClaimData = stored ?? { claims: {}, completed: [] };
    // P2-A — defensive backfill so on-disk data from an older deploy
    // (no ``failures`` field) appears as "no failures" rather than
    // crashing with ``undefined`` lookups.  Zero-cost on hot reads.
    if (!data.failures) data.failures = {};
    this.cached = data;
    return this.cached;
  }

  private async persistState(data: MovieClaimData): Promise<void> {
    this.cached = data;
    await this.state.storage.put(STORAGE_KEY, data);
  }

  /** Idempotent helper to arm the GC alarm.  Re-checking the existing alarm
   *  via storage is cheap (single SQLite read) and prevents alarm thrash. */
  private async scheduleAlarm(): Promise<void> {
    if (this.alarmScheduled) return;
    const existing = await this.state.storage.getAlarm();
    const now = Date.now();
    if (existing !== null && existing > now) {
      this.alarmScheduled = true;
      return;
    }
    await this.state.storage.setAlarm(now + MOVIE_CLAIM_ALARM_INTERVAL_MS);
    this.alarmScheduled = true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (module-private)
// ─────────────────────────────────────────────────────────────────────────────

function clampTtlMs(raw: number): number {
  // ``raw === 0`` means "use server default", same convention as
  // ``GlobalLoginState.handleAcquireLease``.
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_MOVIE_CLAIM_TTL_MS;
  }
  if (raw < MOVIE_CLAIM_TTL_MIN_MS) return MOVIE_CLAIM_TTL_MIN_MS;
  if (raw > MOVIE_CLAIM_TTL_MAX_MS) return MOVIE_CLAIM_TTL_MAX_MS;
  return Math.floor(raw);
}

/** Compute the cooldown duration (ms) for a fresh failure that just
 *  pushed `fail_count` to *count*.  Walks the ladder bottom-up and
 *  returns the largest threshold whose key ``<= count``; for counts
 *  past the dead-letter threshold, pin to the ladder's tail so the
 *  href stays cooled for the rest of the shard. */
function computeCooldownMs(count: number): number {
  if (count >= MOVIE_CLAIM_DEAD_LETTER_THRESHOLD) {
    return lastLadderMs();
  }
  let cooldown = MOVIE_CLAIM_COOLDOWN_LADDER_MS[0]?.[1] ?? 60_000;
  for (const [threshold, ms] of MOVIE_CLAIM_COOLDOWN_LADDER_MS) {
    if (count >= threshold) {
      cooldown = ms;
    }
  }
  return cooldown;
}

/** The longest cooldown in the ladder, used as the dead-letter dwell. */
function lastLadderMs(): number {
  const tail = MOVIE_CLAIM_COOLDOWN_LADDER_MS[MOVIE_CLAIM_COOLDOWN_LADDER_MS.length - 1];
  return tail?.[1] ?? 2 * 60 * 60_000;
}

/** Trim free-form caller-provided strings.  ``error_kind`` is purely
 *  ops metadata so a buggy client can't fill the singleton DO with
 *  multi-megabyte stack traces. */
function clipShortString(raw: string): string {
  const MAX = 256;
  if (raw.length <= MAX) return raw;
  return raw.slice(0, MAX);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
