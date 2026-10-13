const BASE = '/api';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// Error bodies are `{ error: string, issues?: Array<{ path, message }> }`, but
// an older server (or a validation library) can send a non-string `error` —
// render something readable instead of the useless "[object Object]".
function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; issues?: Array<{ path: string; message: string }> };
    if (typeof b.error === 'string' && b.error) return b.error;
    if (Array.isArray(b.issues) && b.issues.length > 0) {
      return b.issues.map(i => `${i.path}: ${i.message}`).join('; ');
    }
    if (b.error !== undefined) {
      try { return JSON.stringify(b.error); } catch { /* fall through to fallback */ }
    }
  }
  return fallback;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, errorMessage(body, res.statusText));
  }
  return res.json() as Promise<T>;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type JobStatus =
  | 'new' | 'shortlist' | 'applied' | 'interview'
  | 'offer' | 'rejected' | 'hidden';

export type Liveness = 'active' | 'expired' | 'uncertain' | 'unchecked';

// Deterministic ghost-job signal. 'high' means "no red flags found",
// never "verified real" — phrase UI copy accordingly.
export type Legitimacy = 'high' | 'caution' | 'suspicious';

export interface LegitimacyReason {
  note: string;
  kind: 'flag' | 'positive';
}

export interface Verdict {
  fit: boolean;
  score: number;
  seniority: string;
  stack_match: string[];
  remote_confirmed: boolean;
  salary_min_usd: number | null;
  reasons: string[];
  // Present only when the job was scored with resume-aware grading enabled.
  background_fit?: number;
  gaps?: string[];
}

export interface Job {
  id: number;
  source_id: number;
  source_name: string;
  source_type: string;
  external_id: string | null;
  url: string;
  title: string;
  company: string;
  location: string | null;
  remote: number | null;
  salary_min_usd: number | null;
  salary_max_usd: number | null;
  salary_currency: string | null;
  // 'jd' when the figure was read from the description text rather than stated by
  // the source. null/'ats' = the source's own field.
  salary_source: 'ats' | 'jd' | null;
  posted_at: number | null;
  jd_text: string | null;
  content_hash: string;
  first_seen: number;
  last_seen: number;
  liveness: Liveness;
  liveness_checked_at: number | null;
  l1_pass: number;
  l1_reasons: string[] | null;
  // 1 when semantic rescue promoted this job past the title rule (title had no
  // search keyword but the description reads like the query).
  l1_rescued: number;
  l2_verdict: Verdict | null;
  legitimacy: Legitimacy | null;
  legitimacy_reasons: LegitimacyReason[] | null;
  duplicate_urls: string[] | null;
  // Semantic dedup: when set, this posting is a near-duplicate folded into the
  // canonical job with this id (hidden from the default list, not L2-scored).
  duplicate_of: number | null;
  // Number of near-duplicate postings folded into this (canonical) job. Present
  // on list/detail rows; 0 when none.
  duplicate_count?: number;
  status: JobStatus;
  applied_at: number | null;
  notes: string | null;
  // Score delta (bounded, +/-0.1) the learned taste applied to this job's rank.
  // null/absent when personalization is inactive or the job has no vector.
  pref_adjust?: number | null;
}

export interface TasteStats {
  triaged: number;
  scored: number;
  mean_score: number | null;
  fit: number;
  not_fit: number;
}

// How L2's grades line up with the user's triage. `liked` = shortlisted/applied,
// `disliked` = dismissed. preference.active = a taste model is reordering results.
export interface Calibration {
  preference: { active: boolean; liked: number; disliked: number };
  liked: TasteStats;
  disliked: TasteStats;
}

// A job returned by the nearest-neighbour endpoint, with its cosine similarity
// (0..1) to the anchor job.
export type SimilarJob = Job & { similarity: number };

export type SourceType =
  | 'greenhouse'
  | 'ashby'
  | 'lever'
  | 'recruitee'
  | 'smartrecruiters'
  | 'workable'
  | 'personio'
  | 'bamboohr'
  | 'workday'
  | 'remoteok'
  | 'arbeitnow'
  | 'himalayas'
  | 'linkedin'
  | 'google_jobs'
  | 'jobicy'
  | 'themuse'
  | 'smartrecruiters_search'
  | 'workingnomads'
  | 'weworkremotely'
  | 'remotive'
  | 'jobtech'
  | 'hn_hiring'
  | 'breezy'
  | 'rippling'
  | 'teamtailor';

export interface Source {
  id: number;
  type: SourceType;
  identifier: string;
  display_name: string;
  enabled: number;
  config_json: string | null;
  last_scan_at: number | null;
  last_status: string | null;
  last_error: string | null;
  /** Start of the last complete successful fetch. last_scan_at is the last attempt. */
  last_ok_fetch_at: number | null;
  created_at: number;
  origin: string | null;
}

export interface Run {
  id: number;
  started_at: number;
  finished_at: number | null;
  sources_total: number;
  jobs_found: number;
  jobs_new: number;
  jobs_l1_pass: number;
  jobs_l2_pass: number;
  errors: { source: string; error: string }[];
  trigger: string;
  query: string | null;
  /** Survivors left ungraded when the run finished (cap or failed batches). */
  l2_pending?: number;
}

// What Claude parsed the natural-language search into — surfaced as the
// "here's what Lantern understood" chips on the Search page.
export interface InterpretedCriteria {
  title: { positive: string[]; negative: string[] };
  location: { remote_required: boolean; allowed: string[]; block?: string[]; always_allow?: string[] };
  seniority: { allowed: string[] };
  salary_min_usd: number | null;
  salary_currency?: string;
  exclude_companies: string[];
  experience_years: { min: number | null; max: number | null } | null;
  // Optional because a re-scan without a query echoes a stored row that may predate them.
  employment_types?: string[];
  visa_sponsorship_required?: boolean;
  skills?: { must: string[]; nice: string[] };
  industries?: { include: string[]; exclude: string[] };
  company_stage?: string[];
}

// Format a salary amount in its native currency. Falls back to a "CODE amount"
// string for codes Intl doesn't recognize. Null currency renders as USD.
export function formatMoney(amount: number, currency?: string | null): string {
  const code = (currency ?? 'USD').toUpperCase();
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${code} ${amount.toLocaleString()}`;
  }
}

export interface HealthCheck {
  ok: boolean;
  checks: Record<string, { ok: boolean; detail?: string; deprecation?: string }>;
}

// claude-code is the only provider since the Phase 8 strip-down.
export type LlmProviderName = 'claude-code';
export type LlmTask = 'verdict' | 'nl-filter';

export interface LlmSettings {
  per_task_overrides?: Partial<Record<LlmTask, string>>;
}

export interface LlmSettingsResponse {
  settings: LlmSettings;
  provider: LlmProviderName;
  tasks: LlmTask[];
}

// Master/baseline resume for triage scoring. Canonical form is TEXT — a PDF
// can be imported via extract, but only the (user-reviewed) text is saved.
export interface ResumeSettings {
  enabled: boolean;
  text: string;
}

// Local semantic pre-ranker toggle. When on, an on-device embedding model
// (~25MB, downloaded once) orders L1 survivors so the best matches are scored
// first. Off skips the model entirely.
export interface EmbeddingSettings {
  enabled: boolean;
}

// L1 freshness gate. When on, dated jobs older than `maxAgeDays` fail L1 (never
// reach L2); jobs with no posted date always pass.
export interface FreshnessSettings {
  enabled: boolean;
  maxAgeDays: number;
}

// Per-search cap on how many survivors L2 grades; the rest wait for a repeat search.
export interface L2CapSettings {
  maxJobs: number;
}

// How long a company board's last good fetch is reused. Within it a scan re-checks
// the stored jobs against the new search instead of fetching the board. 0 = always fetch.
export interface BoardCacheSettings {
  ttlHours: number;
}

// Background refresher that keeps enabled company boards fresh so searches are served
// from the board cache. `status` is read-only and live.
export interface BoardRefreshStatus {
  enabled: boolean;
  running: boolean;
  idleReason: 'off' | 'cache-off' | 'scan-running' | 'nothing-stale' | 'busy' | null;
  boards: { total: number; fresh: number; stale: number; backedOff: number };
  refreshing: string[];
  restingHosts: string[];
  lastTickAt: number | null;
  lastTick: { attempted: number; ok: number; failed: number; aborted: number } | null;
  nextTickAt: number | null;
  lastError: { board: string; error: string; at: number } | null;
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export const api = {
  jobs: {
    list: (params?: {
      status?: string;
      l1?: '1';
      l2?: '1';
      fit?: '1';
      remote?: '1';
      source_type?: string;
      run?: string;
      q?: string;
      limit?: number;
      offset?: number;
    }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set('status', params.status);
      if (params?.l1) qs.set('l1', params.l1);
      if (params?.l2) qs.set('l2', params.l2);
      if (params?.fit) qs.set('fit', params.fit);
      if (params?.remote) qs.set('remote', params.remote);
      if (params?.source_type) qs.set('source_type', params.source_type);
      if (params?.run) qs.set('run', params.run);
      if (params?.q) qs.set('q', params.q);
      if (params?.limit) qs.set('limit', String(params.limit));
      if (params?.offset) qs.set('offset', String(params.offset));
      return request<{ jobs: Job[]; total: number; limit: number; offset: number }>(
        `/jobs?${qs}`
      );
    },
    get: (id: number) => request<Job>(`/jobs/${id}`),
    calibration: () => request<Calibration>('/jobs/calibration'),
    similar: (id: number, limit = 6) =>
      request<{ jobs: SimilarJob[] }>(`/jobs/${id}/similar?limit=${limit}`),
    duplicates: (id: number) =>
      request<{ jobs: Job[] }>(`/jobs/${id}/duplicates`),
    setStatus: (id: number, status: JobStatus) =>
      request<{ ok: boolean }>(`/jobs/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    setNotes: (id: number, notes: string) =>
      request<{ ok: boolean }>(`/jobs/${id}/notes`, {
        method: 'PATCH',
        body: JSON.stringify({ notes }),
      }),
  },

  sources: {
    list: () => request<{ sources: Source[] }>('/sources'),
    // Discovered boards are thousands of rows, so they are counted and toggled in bulk
    // instead of listed.
    discovered: () => request<{ total: number; enabled: number }>('/sources/discovered'),
    setDiscovered: (enabled: boolean) =>
      request<{ ok: boolean; total: number; enabled: number }>('/sources/discovered', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      }),
    create: (body: {
      type: SourceType;
      identifier: string;
      display_name: string;
      enabled?: boolean;
      config_json?: Record<string, unknown>;
    }) => request<{ id: number }>('/sources', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: number, body: { display_name?: string; enabled?: boolean; config_json?: Record<string, unknown> }) =>
      request<{ ok: boolean }>(`/sources/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    // Seeded sources (or ones with saved jobs) can't be hard-deleted server-side —
    // the endpoint turns them off instead and says so.
    delete: (id: number) =>
      request<{ ok: true; deleted: true } | { ok: true; disabled: true; msg: string }>(
        `/sources/${id}`,
        { method: 'DELETE' }
      ),
  },

  runs: {
    list: (limit = 20) => request<{ runs: Run[] }>(`/runs?limit=${limit}`),
    get: (id: number) => request<Run>(`/runs/${id}`),
    // A natural-language query drives the search; the backend interprets it into
    // criteria via Claude before scanning. Omitted = plain re-scan of current criteria.
    startScan: (query?: string) =>
      request<{ ok: boolean; msg: string; criteria: InterpretedCriteria | null; runId: number }>('/runs/scan', {
        method: 'POST',
        body: JSON.stringify(query ? { query } : {}),
      }),
    recentQueries: () => request<{ queries: string[] }>('/runs/recent-queries'),
  },

  health: {
    // The endpoint returns 503 when any single check fails, but the body still
    // carries the per-check detail — parse it regardless so a failing LLM check
    // doesn't mask a healthy DB. `deep` also runs the (slower) model probe —
    // used for the explicit "Re-check" button, not the cheap mount-time check.
    check: async (deep = false): Promise<HealthCheck> => {
      const res = await fetch(`${BASE}/health${deep ? '?deep=1' : ''}`);
      const body = await res.json().catch(() => null);
      if (body && typeof body === 'object' && 'checks' in body) return body as HealthCheck;
      throw new ApiError(res.status, res.statusText);
    },
  },

  admin: {
    clearJobs: () => request<{ ok: boolean; msg: string }>('/admin/clear-jobs', { method: 'POST' }),
  },

  llmSettings: {
    get: () => request<LlmSettingsResponse>('/settings/llm'),
    save: (settings: LlmSettings) =>
      request<{ ok: boolean; settings: LlmSettings }>('/settings/llm', {
        method: 'PUT',
        body: JSON.stringify(settings),
      }),
  },

  resume: {
    get: () => request<{ settings: ResumeSettings }>('/settings/resume'),
    save: (settings: ResumeSettings) =>
      request<{ ok: boolean; settings: ResumeSettings }>('/settings/resume', {
        method: 'PUT',
        body: JSON.stringify(settings),
      }),
    // Transient PDF→text: nothing is stored server-side; the result goes into
    // the editable textarea for review before saving.
    extract: async (file: File): Promise<{ text: string }> => {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${BASE}/settings/resume/extract`, { method: 'POST', body: form });
      const body = await res.json().catch(() => ({ error: res.statusText }));
      if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
      return body as { text: string };
    },
  },

  embeddings: {
    get: () => request<{ settings: EmbeddingSettings }>('/settings/embeddings'),
    save: (settings: EmbeddingSettings) =>
      request<{ ok: boolean; settings: EmbeddingSettings }>('/settings/embeddings', {
        method: 'PUT',
        body: JSON.stringify(settings),
      }),
  },

  freshness: {
    get: () => request<{ settings: FreshnessSettings }>('/settings/freshness'),
    save: (settings: FreshnessSettings) =>
      request<{ ok: boolean; settings: FreshnessSettings }>('/settings/freshness', {
        method: 'PUT',
        body: JSON.stringify(settings),
      }),
  },

  l2Cap: {
    get: () => request<{ settings: L2CapSettings }>('/settings/l2-cap'),
    save: (settings: L2CapSettings) =>
      request<{ ok: boolean; settings: L2CapSettings }>('/settings/l2-cap', {
        method: 'PUT',
        body: JSON.stringify(settings),
      }),
  },

  boardCache: {
    get: () => request<{ settings: BoardCacheSettings }>('/settings/board-cache'),
    save: (settings: BoardCacheSettings) =>
      request<{ ok: boolean; settings: BoardCacheSettings }>('/settings/board-cache', {
        method: 'PUT',
        body: JSON.stringify(settings),
      }),
  },

  boardRefresh: {
    get: () => request<{ settings: { enabled: boolean }; status: BoardRefreshStatus }>('/settings/board-refresh'),
    save: (enabled: boolean) =>
      request<{ ok: boolean; settings: { enabled: boolean }; status: BoardRefreshStatus }>('/settings/board-refresh', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      }),
  },

  attachments: {
    list: (jobId: number) =>
      request<{ attachments: unknown[] }>(`/attachments/job/${jobId}`),
    upload: (jobId: number, file: File, kind: 'resume' | 'cover_letter' | 'other') => {
      const form = new FormData();
      form.append('file', file);
      form.append('kind', kind);
      return fetch(`${BASE}/attachments/${jobId}`, { method: 'POST', body: form }).then(r => r.json());
    },
    delete: (id: number) => request<{ ok: boolean }>(`/attachments/${id}`, { method: 'DELETE' }),
  },
};
