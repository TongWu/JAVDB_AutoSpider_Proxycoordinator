import {
  ClaimMovieRequest,
  ClaimMovieResponse,
  CommitCompletedMoviesRequest,
  CommitCompletedMoviesResponse,
  CompleteMovieRequest,
  CompleteMovieResponse,
  DEFAULT_MOVIE_CLAIM_TTL_MS,
  DEFAULT_SWEEP_ORPHAN_MS,
  Env,
  MIN_SWEEP_ORPHAN_MS,
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
  RollbackStagedMoviesRequest,
  RollbackStagedMoviesResponse,
  StageCompleteMovieRequest,
  StageCompleteMovieResponse,
  SweepOrphanStagesResponse,
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

/** Phase-1 — staged-but-not-yet-committed completion record.  A successful
 *  detail fetch records the href here instead of jumping straight to
 *  ``completed_committed[]``; the spider's session-end CLI then either
 *  promotes the entry to ``completed_committed[]`` (commit path) or
 *  removes it (rollback path).  The ``session_id`` ties the staged entry
 *  to the spider session that produced it so a per-session
 *  commit / rollback never touches a sibling session's stages. */
interface StagedCompletion {
  /** ``ReportSessions.Id`` rendered as a string (D1 / SQLite uses INTEGER
   *  but we keep the wire format stringy so JSON round-trips don't
   *  silently truncate via the JS Number 53-bit limit). */
  session_id: string;
  /** Wall-clock ms epoch when the stage was recorded.  Drives the
   *  ``sweep_orphan_stages`` cron's age comparison. */
  ts: number;
}

interface MovieClaimData {
  /** Active per-href claims keyed by movie detail href. */
  claims: Record<string, MovieClaim>;
  /**
   * Hrefs that have already finished this shard *and* whose owning
   * session is committed.  Stored as a plain object (``Record<href,
   * true>``) for O(1) membership tests.  D.3 renamed the field's
   * runtime shape from ``string[]``; :func:`loadState` migrates both
   * the legacy ``completed`` field (pre-Phase-1) and the old
   * ``string[]`` form (Phase-1 pre-D.3) on first read.
   */
  completed_committed: Record<string, true>;
  /** Phase-1 — staged completions waiting on a commit / rollback decision.
   *  Keyed by href; the value tracks the owning session_id and the wall-
   *  clock timestamp.  ``undefined`` (legacy) when this shard predates
   *  the Phase-1 schema bump; :func:`loadState` initialises the field
   *  on read. */
  staged_complete?: Record<string, StagedCompletion>;
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
        case "/do/stage_complete_movie":
          return await this.handleStageComplete(request);
        case "/do/commit_completed_movies":
          return await this.handleCommitCompleted(request);
        case "/do/rollback_staged_movies":
          return await this.handleRollbackStaged(request);
        case "/do/sweep_orphan_stages":
          return await this.handleSweepOrphanStages(url);
        case "/do/report_failure":
          return await this.handleReportFailure(request);
        case "/do/movie_status":
          return await this.handleStatus(url);
        // Phase-3 ADR-008 — per-shard claim stats for the dashboard panel.
        case "/do/movie_claim/stats":
          return await this.handleClaimStats();
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("MovieClaimState DO handler error", {
        path: url.pathname,
        error: message,
      });
      return jsonResponse({ error: "internal_error" }, 500);
    }
  }

  /**
   * DO Alarm — fires every {@link MOVIE_CLAIM_ALARM_INTERVAL_MS} to GC
   * expired claims.  Cloudflare invokes this independently of inbound
   * requests, so a shard with crashed claim holders still recovers without
   * waiting for the next request.
   */
  async alarm(): Promise<void> {
    this.alarmScheduled = false;
    const data = await this.loadState();
    const now = Date.now();
    let purged = 0;
    const BATCH_LIMIT = 500;
    let limitHit = false;
    for (const href of Object.keys(data.claims)) {
      if (purged >= BATCH_LIMIT) { limitHit = true; break; }
      if (data.claims[href].expires_at <= now) {
        delete data.claims[href];
        purged += 1;
      }
    }
    if (!limitHit && data.failures) {
      for (const href of Object.keys(data.failures)) {
        if (purged >= BATCH_LIMIT) { limitHit = true; break; }
        if (data.failures[href].last_failure_at <= now - MOVIE_CLAIM_FAILURE_TTL_MS) {
          delete data.failures[href];
          purged += 1;
        }
      }
    }
    if (purged > 0) {
      await this.persistState(data);
    }
    if (limitHit) {
      await this.state.storage.setAlarm(now + 60_000);
      this.alarmScheduled = true;
      return;
    }
    const hasLiveState =
      Object.keys(data.claims).length > 0 ||
      (data.failures !== undefined && Object.keys(data.failures).length > 0) ||
      (data.staged_complete !== undefined && Object.keys(data.staged_complete).length > 0);
    if (hasLiveState) {
      await this.scheduleAlarm();
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
    const sessionId = String(body.session_id ?? "").trim();
    const ttlMs = clampTtlMs(Number(body.ttl_ms ?? 0));

    const now = Date.now();
    const data = await this.loadState();
    const failure = data.failures?.[href];
    const staged = data.staged_complete?.[href];

    // Already committed inside this shard → never re-claim, surface to caller
    // so they can short-circuit + mark their local history.
    if (href in data.completed_committed) {
      const response: ClaimMovieResponse = {
        acquired: false,
        current_holder_id: "",
        expires_at: 0,
        already_completed: true,
        cooldown_until: 0,
        staged_session_id: staged?.session_id ?? "",
        server_time: now,
      };
      return jsonResponse(response);
    }

    // Phase-1 — same-session idempotent skip on a staged completion.
    // A peer session's staged entry deliberately does NOT block: that's
    // the whole point of the rollback-safety split (a daily-run rollback
    // must not block adhoc retries on the same href).
    if (staged && sessionId && staged.session_id === sessionId) {
      const response: ClaimMovieResponse = {
        acquired: false,
        current_holder_id: "",
        expires_at: 0,
        already_completed: true,
        cooldown_until: 0,
        staged_session_id: staged.session_id,
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
        staged_session_id: staged?.session_id ?? "",
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
      staged_session_id: staged?.session_id ?? "",
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
    if (href in data.completed_committed) {
      completed = true;
    } else if (existing && existing.holder_id === holderId) {
      delete data.claims[href];
      data.completed_committed[href] = true;
      // P2-A — a successful complete wipes the failure / cooldown
      // record so the next re-ingestion (different shard date, or a
      // forced retry) starts from a clean slate.
      if (data.failures && data.failures[href]) {
        delete data.failures[href];
      }
      // Phase-1 — clear any staged entry too: an explicit commit-skipping
      // ``complete_movie`` (legacy contract) is the operator saying "this
      // is final, no rollback expected".
      if (data.staged_complete && data.staged_complete[href]) {
        delete data.staged_complete[href];
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
   * Phase-1 — record a staged completion that survives until commit /
   * rollback.  Mirrors :meth:`handleComplete` but writes into
   * ``staged_complete{}`` instead of ``completed_committed[]`` so a
   * subsequent ``rollback_staged_movies`` can erase the runner's
   * footprint without leaving a "permanently completed" lock that
   * blocks adhoc retries.
   *
   * Idempotent w.r.t. the *same* (href, session_id): a re-stage refreshes
   * ``ts`` but does not move the entry to a different session.  A stage
   * from a *different* session_id when an entry already exists is
   * rejected with ``staged=false`` so a buggy caller can't silently
   * steal another session's stage; ops can resolve the conflict via
   * /movie_status + /rollback_staged_movies.
   */
  private async handleStageComplete(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<StageCompleteMovieRequest>;
    const href = String(body.href ?? "").trim();
    const holderId = String(body.holder_id ?? "").trim();
    const sessionId = String(body.session_id ?? "").trim();
    if (!href || !holderId || !sessionId) {
      return jsonResponse(
        { error: "missing href, holder_id, or session_id" },
        400,
      );
    }

    const now = Date.now();
    const data = await this.loadState();
    if (!data.staged_complete) data.staged_complete = {};

    let staged = false;
    let resolvedSessionId = sessionId;

    // If already committed, treat as success (idempotent).  No staged
    // entry is needed because the work is permanently durable.
    if (href in data.completed_committed) {
      const response: StageCompleteMovieResponse = {
        staged: true,
        href,
        session_id: sessionId,
        server_time: now,
      };
      return jsonResponse(response);
    }

    const existing = data.claims[href];
    const priorStage = data.staged_complete[href];
    if (priorStage && priorStage.session_id === sessionId) {
      // Same-session idempotent re-stage. B.12 (2026-05-12): require
      // the caller to be the *active claim holder* on this href before
      // accepting the re-stage. ``session_id`` is opaque to the DO and
      // could be reused by a buggy / malicious peer to refresh a
      // sibling runner's stage timestamp; tying re-stages back to the
      // claim holder closes that gap. If there's no active claim
      // anymore (claim TTL elapsed) we still accept — the prior stage
      // already represents committed-intent work.  However, ``ts`` is
      // only refreshed when the caller still holds an active claim;
      // without one the original ``ts`` is preserved so orphan-sweep
      // can eventually catch truly abandoned stages (W2.7).
      if (existing && existing.holder_id !== holderId) {
        const response: StageCompleteMovieResponse = {
          staged: false,
          href,
          session_id: priorStage.session_id,
          server_time: now,
        };
        return jsonResponse(response);
      }
      data.staged_complete[href] = {
        session_id: sessionId,
        ts: existing ? now : priorStage.ts,
      };
      // Drop the active claim if this caller still owns it — symmetric
      // with handleComplete; lets peer sessions race the (unblocked)
      // claim if they want to re-stage from scratch.
      if (existing && existing.holder_id === holderId) {
        delete data.claims[href];
      }
      await this.persistState(data);
      staged = true;
    } else if (priorStage) {
      // Different session already staged this href.  Refuse — the
      // existing stage is preserved; the caller observes ``staged=false``
      // plus the winner's session_id and can decide whether to wait
      // for the peer's commit / rollback before retrying.
      resolvedSessionId = priorStage.session_id;
      staged = false;
    } else if (existing && existing.holder_id === holderId) {
      // Fresh stage by the active holder — the canonical happy path.
      delete data.claims[href];
      data.staged_complete[href] = {
        session_id: sessionId,
        ts: now,
      };
      // P2-A — a successful stage also wipes the failure record so a
      // subsequent commit lands on a clean slate.  Mirrors handleComplete.
      if (data.failures && data.failures[href]) {
        delete data.failures[href];
      }
      await this.persistState(data);
      await this.scheduleAlarm();
      staged = true;
    } else {
      // No active claim or stale holder — refuse.  ``staged=false``
      // signals the caller to release / re-claim.
      staged = false;
    }

    const response: StageCompleteMovieResponse = {
      staged,
      href,
      session_id: resolvedSessionId,
      server_time: now,
    };
    return jsonResponse(response);
  }

  /**
   * Phase-1 — promote every staged entry whose ``session_id`` matches
   * into ``completed_committed[]``.  Idempotent: zero matching stages
   * is the steady state once a successful commit has run.
   *
   * Concurrency: a commit issued mid-run is safe because the DO
   * serialises requests — a stage that arrives after this commit will
   * land in ``staged_complete{}`` again with the same session_id and
   * a follow-up commit (or stale-session sweep) will tidy it up.
   */
  private async handleCommitCompleted(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<CommitCompletedMoviesRequest>;
    const sessionId = String(body.session_id ?? "").trim();
    if (!sessionId) {
      return jsonResponse({ error: "missing session_id" }, 400);
    }

    const now = Date.now();
    const data = await this.loadState();
    let promoted = 0;

    if (data.staged_complete) {
      for (const href of Object.keys(data.staged_complete)) {
        if (data.staged_complete[href].session_id !== sessionId) continue;
        delete data.staged_complete[href];
        // Idempotent against ``completed_committed`` — a peer caller
        // could have called legacy ``complete_movie`` for the same href
        // already; the Record shape makes this a no-op set write.
        data.completed_committed[href] = true;
        promoted += 1;
      }
      if (promoted > 0) {
        await this.persistState(data);
      }
    }

    const response: CommitCompletedMoviesResponse = {
      promoted,
      session_id: sessionId,
      server_time: now,
    };
    return jsonResponse(response);
  }

  /**
   * Phase-1 — drop every staged entry whose ``session_id`` matches.
   * Idempotent.  After this call returns the rolled-back session can no
   * longer cause peer claim attempts to short-circuit on
   * ``already_completed=true``, so an adhoc retry of the same href will
   * actually proceed with a fresh fetch.
   */
  private async handleRollbackStaged(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<RollbackStagedMoviesRequest>;
    const sessionId = String(body.session_id ?? "").trim();
    if (!sessionId) {
      return jsonResponse({ error: "missing session_id" }, 400);
    }

    const now = Date.now();
    const data = await this.loadState();
    let removed = 0;

    if (data.staged_complete) {
      for (const href of Object.keys(data.staged_complete)) {
        if (data.staged_complete[href].session_id !== sessionId) continue;
        delete data.staged_complete[href];
        removed += 1;
      }
      if (removed > 0) {
        await this.persistState(data);
      }
    }

    const response: RollbackStagedMoviesResponse = {
      removed,
      session_id: sessionId,
      server_time: now,
    };
    return jsonResponse(response);
  }

  /**
   * Phase-1 — defence-in-depth sweep that prunes ``staged_complete{}``
   * entries older than ``older_than_ms``.  Designed for a cron caller
   * (StaleSessionCleanup workflow) that catches stages whose owning
   * session crashed before either commit or rollback ran.  The session
   * itself is NOT consulted here — operators run this with a generous
   * cutoff (default 48h) to make sure a long-running ingestion is not
   * mistakenly cleaned.
   */
  private async handleSweepOrphanStages(url: URL): Promise<Response> {
    const rawOlderThan = url.searchParams.get("older_than_ms");
    let olderThanMs = Number(rawOlderThan);
    if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
      olderThanMs = DEFAULT_SWEEP_ORPHAN_MS;
    }
    if (olderThanMs < MIN_SWEEP_ORPHAN_MS) {
      olderThanMs = MIN_SWEEP_ORPHAN_MS;
    }

    const now = Date.now();
    const cutoff = now - olderThanMs;
    const data = await this.loadState();
    let removed = 0;

    if (data.staged_complete) {
      for (const href of Object.keys(data.staged_complete)) {
        if (data.staged_complete[href].ts <= cutoff) {
          delete data.staged_complete[href];
          removed += 1;
        }
      }
      if (removed > 0) {
        await this.persistState(data);
      }
    }

    const response: SweepOrphanStagesResponse = {
      removed,
      cutoff_ms: cutoff,
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
    const staged = data.staged_complete?.[href] ?? null;
    const response: MovieStatusResponse = {
      current_holder_id: existing?.holder_id ?? null,
      expires_at: existing?.expires_at ?? 0,
      already_completed: href in data.completed_committed,
      cooldown_until: failure?.next_attempt_at ?? 0,
      last_error_kind: failure?.last_error_kind ?? "",
      fail_count: failure?.fail_count ?? 0,
      staged_session_id: staged?.session_id ?? "",
      staged_at: staged?.ts ?? 0,
      server_time: now,
    };
    return jsonResponse(response);
  }

  /**
   * Phase-3 ADR-008 — per-shard stats for the dashboard's
   * "Today's Claims" card.  Returns the four counts that the
   * Worker's `/movie_claim/stats` fan-out merges across all
   * sub-shards.  ``in_cooldown`` is best-effort (cooldown windows
   * outlive a single shard if the operator changes the failure
   * ladder mid-flight).
   */
  private async handleClaimStats(): Promise<Response> {
    const data = await this.loadState();
    const now = Date.now();
    let inCooldown = 0;
    let deadLettered = 0;
    if (data.failures) {
      for (const f of Object.values(data.failures)) {
        if (f.next_attempt_at > now) inCooldown += 1;
        if (f.fail_count >= MOVIE_CLAIM_DEAD_LETTER_THRESHOLD) deadLettered += 1;
      }
    }
    let activeClaims = 0;
    for (const c of Object.values(data.claims)) {
      if (c.expires_at > now) activeClaims += 1;
    }
    return jsonResponse({
      claims_active: activeClaims,
      staged_count: data.staged_complete ? Object.keys(data.staged_complete).length : 0,
      completed_committed_count: Object.keys(data.completed_committed).length,
      failures_count: data.failures ? Object.keys(data.failures).length : 0,
      in_cooldown_count: inCooldown,
      dead_lettered_count: deadLettered,
      server_time: now,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Storage helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async loadState(): Promise<MovieClaimData> {
    if (this.cached !== null) return this.cached;
    /** Read shape includes the legacy ``completed`` field so we can migrate
     *  data persisted by pre-Phase-1 Workers without forcing a coordinated
     *  re-deploy.  Once every active shard has been touched by a Phase-1
     *  Worker the legacy field is dropped on first persist. */
    const stored =
      (await this.state.storage.get<
        Partial<MovieClaimData> & { completed?: string[] }
      >(STORAGE_KEY)) ?? null;
    const data: MovieClaimData = {
      claims: stored?.claims ?? {},
      // Three-tier migration for completed_committed:
      //   D.3+ shape  : Record<string, true>  → use as-is
      //   Phase-1 shape: string[]             → Object.fromEntries
      //   Pre-Phase-1  : stored?.completed[]  → Object.fromEntries
      completed_committed: (() => {
        const cc = stored?.completed_committed as unknown;
        if (Array.isArray(cc))
          return Object.fromEntries((cc as string[]).map((h) => [h, true as true]));
        if (cc && typeof cc === "object") return cc as Record<string, true>;
        const leg = stored?.completed;
        if (Array.isArray(leg))
          return Object.fromEntries(leg.map((h) => [h, true as true]));
        return {} as Record<string, true>;
      })(),
      staged_complete: stored?.staged_complete ?? {},
      failures: stored?.failures ?? {},
    };
    this.cached = data;
    return this.cached;
  }

  private async persistState(data: MovieClaimData): Promise<void> {
    // Write storage first, then update the in-memory cache. The reverse
    // ordering leaks unpersisted state into ``cached`` if ``put`` throws:
    // subsequent requests on the same DO instance would observe a
    // snapshot the next instance reload could never see, which is
    // particularly bad for the claim / stage flow where peers rely on
    // shard-wide observability.
    await this.state.storage.put(STORAGE_KEY, data);
    this.cached = data;
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
