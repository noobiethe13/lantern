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
  status: JobStatus;
  applied_at: number | null;
  notes: string | null;
}

export type SourceType =
  | 'greenhouse' | 'ashby' | 'lever'
  | 'hn-whos-hiring' | 'generic-url';

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
}

export interface Criteria {
  yaml: string;
  source_text: string | null;
  updated_at: number | null;
}

export interface HealthCheck {
  ok: boolean;
  checks: Record<string, { ok: boolean; detail?: string; deprecation?: string }>;
}

export type LlmProviderName = 'gemini-api' | 'claude-code' | 'antigravity-cli' | 'ollama';
export type LlmTask = 'verdict' | 'nl-filter' | 'html-extract' | 'hn-extract';

export interface LlmSettings {
  provider: LlmProviderName;
  gemini_api_key?: string;
  ollama_base_url?: string;
  per_task_overrides?: Partial<Record<LlmTask, string>>;
}

export interface LlmSettingsResponse {
  settings: LlmSettings;
  available_providers: LlmProviderName[];
  tasks: LlmTask[];
  deprecations: Partial<Record<LlmProviderName, string>>;
}

export interface LlmHealth {
  provider: LlmProviderName;
  ok: boolean;
  detail: string;
  deprecation?: string;
}

export interface OllamaModel {
  name: string;
  size?: number;
  modified_at?: string;
}

export interface OllamaModelsResponse {
  baseUrl: string;
  models: OllamaModel[];
  error?: string;
}

export type SourceTestKind = 'http' | 'gated' | 'auth' | 'extract' | 'unsupported';

export interface SourceTestResult {
  ok: boolean;
  kind?: SourceTestKind;
  detail: string;
  finalUrl?: string;
  title?: string;
  contentKind?: 'innerText' | 'outerHTML';
  snippet?: string;
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export const api = {
  jobs: {
    list: (params?: {
      status?: string;
      l1?: '1';
      l2?: '1';
      q?: string;
      limit?: number;
      offset?: number;
    }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set('status', params.status);
      if (params?.l1) qs.set('l1', params.l1);
      if (params?.l2) qs.set('l2', params.l2);
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
    test: (id: number) =>
      request<SourceTestResult>(`/sources/${id}/test`, { method: 'POST' }),
  },

  criteria: {
    get: () => request<Criteria>('/criteria'),
    save: (yamlStr: string) =>
      request<{ ok: boolean }>('/criteria', { method: 'PUT', body: JSON.stringify({ yaml: yamlStr }) }),
    fromNL: (text: string) =>
      request<{ yaml: string; parsed: unknown }>('/criteria/from-nl', {
        method: 'POST',
        body: JSON.stringify({ text }),
      }),
  },

  runs: {
    list: (limit = 20) => request<{ runs: Run[] }>(`/runs?limit=${limit}`),
    get: (id: number) => request<Run>(`/runs/${id}`),
    startScan: () => request<{ ok: boolean; msg: string }>('/runs/scan', { method: 'POST' }),
  },

  health: {
    check: () => request<HealthCheck>('/health'),
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
    ollamaModels: (baseUrl?: string) => {
      const qs = baseUrl ? `?baseUrl=${encodeURIComponent(baseUrl)}` : '';
      return request<OllamaModelsResponse>(`/settings/llm/ollama-models${qs}`);
    },
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
