const BASE = '/api';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type JobStatus =
  | 'new' | 'shortlist' | 'applied' | 'interview'
  | 'offer' | 'rejected' | 'hidden' | 'archived';

export type Liveness = 'active' | 'expired' | 'uncertain' | 'unchecked';

export interface Verdict {
  fit: boolean;
  score: number;
  seniority: string;
  stack_match: string[];
  remote_confirmed: boolean;
  salary_min_usd: number | null;
  reasons: string[];
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
  posted_at: number | null;
  jd_text: string | null;
  content_hash: string;
  first_seen: number;
  last_seen: number;
  liveness: Liveness;
  liveness_checked_at: number | null;
  l1_pass: number;
  l1_reasons: string[] | null;
  l2_verdict: Verdict | null;
  duplicate_urls: string[] | null;
  status: JobStatus;
  applied_at: number | null;
  notes: string | null;
}

export type SourceType =
  | 'greenhouse'
  | 'ashby'
  | 'lever'
  | 'recruitee'
  | 'smartrecruiters'
  | 'workable'
  | 'personio'
  | 'remoteok'
  | 'arbeitnow'
  | 'himalayas';

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
  created_at: number;
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
}

// What Claude parsed the natural-language search into — surfaced as the
// "here's what Lantern understood" chips on the Search page.
export interface InterpretedCriteria {
  title: { positive: string[]; negative: string[] };
  location: { remote_required: boolean; allowed: string[] };
  seniority: { allowed: string[] };
  salary_min_usd: number | null;
  exclude_companies: string[];
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

export interface LlmHealth {
  provider: LlmProviderName;
  ok: boolean;
  detail: string;
  deprecation?: string;
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export const api = {
  jobs: {
    list: (params?: {
      status?: string;
      l1?: '1';
      l2?: '1';
      fit?: '1';
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
      if (params?.run) qs.set('run', params.run);
      if (params?.q) qs.set('q', params.q);
      if (params?.limit) qs.set('limit', String(params.limit));
      if (params?.offset) qs.set('offset', String(params.offset));
      return request<{ jobs: Job[]; total: number; limit: number; offset: number }>(
        `/jobs?${qs}`
      );
    },
    get: (id: number) => request<Job>(`/jobs/${id}`),
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
    create: (body: {
      type: SourceType;
      identifier: string;
      display_name: string;
      enabled?: boolean;
      config_json?: Record<string, unknown>;
    }) => request<{ id: number }>('/sources', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: number, body: { display_name?: string; enabled?: boolean; config_json?: Record<string, unknown> }) =>
      request<{ ok: boolean }>(`/sources/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (id: number) => request<{ ok: boolean }>(`/sources/${id}`, { method: 'DELETE' }),
  },

  runs: {
    list: (limit = 20) => request<{ runs: Run[] }>(`/runs?limit=${limit}`),
    get: (id: number) => request<Run>(`/runs/${id}`),
    // A natural-language query drives the search; the backend interprets it into
    // criteria via Claude before scanning. Omitted = plain re-scan of current criteria.
    startScan: (query?: string) =>
      request<{ ok: boolean; msg: string; criteria: InterpretedCriteria | null }>('/runs/scan', {
        method: 'POST',
        body: JSON.stringify(query ? { query } : {}),
      }),
    recentQueries: () => request<{ queries: string[] }>('/runs/recent-queries'),
  },

  health: {
    // The endpoint returns 503 when any single check fails, but the body still
    // carries the per-check detail — parse it regardless so a failing LLM check
    // doesn't mask a healthy DB.
    check: async (): Promise<HealthCheck> => {
      const res = await fetch(`${BASE}/health`);
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
    health: () => request<LlmHealth>('/settings/llm/health'),
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
