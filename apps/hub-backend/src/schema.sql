CREATE TABLE IF NOT EXISTS projects (
  project_slug TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  project_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'online',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ,
  retirement_mode TEXT
);

CREATE TABLE IF NOT EXISTS threads (
  thread_id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL REFERENCES projects(project_slug) ON DELETE CASCADE,
  title TEXT,
  status TEXT,
  started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_turn_id TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  turn_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
  project_slug TEXT NOT NULL REFERENCES projects(project_slug) ON DELETE CASCADE,
  status TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL REFERENCES projects(project_slug) ON DELETE CASCADE,
  thread_id TEXT,
  turn_id TEXT,
  event_type TEXT NOT NULL,
  status TEXT,
  title TEXT,
  error_message TEXT,
  payload_json JSONB NOT NULL,
  event_ts TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exec_audit_logs (
  log_id TEXT PRIMARY KEY,
  project_slug TEXT,
  route TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  request_ip TEXT,
  request_origin TEXT,
  user_agent TEXT,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_last_seen ON projects(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_status_retired ON projects(status, retired_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_project_updated ON threads(project_slug, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_thread_updated ON turns(thread_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_project_ts ON events(project_slug, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_thread_ts ON events(thread_id, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(event_type, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_threads_status_updated ON threads(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_exec_audit_created ON exec_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exec_audit_project_created ON exec_audit_logs(project_slug, created_at DESC);


CREATE TABLE IF NOT EXISTS missions (
  mission_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mission_projects (
  mission_project_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(mission_id) ON DELETE CASCADE,
  project_slug TEXT NOT NULL REFERENCES projects(project_slug) ON DELETE CASCADE,
  project_role TEXT,
  task_goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  thread_id TEXT,
  latest_summary TEXT,
  latest_change_count INT NOT NULL DEFAULT 0,
  waiting_for_user BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mission_id, project_slug)
);

CREATE TABLE IF NOT EXISTS mission_project_dependencies (
  dependency_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(mission_id) ON DELETE CASCADE,
  from_project_slug TEXT NOT NULL REFERENCES projects(project_slug) ON DELETE CASCADE,
  to_project_slug TEXT NOT NULL REFERENCES projects(project_slug) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mission_id, from_project_slug, to_project_slug)
);

CREATE TABLE IF NOT EXISTS mission_handoffs (
  handoff_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(mission_id) ON DELETE CASCADE,
  from_project_slug TEXT NOT NULL REFERENCES projects(project_slug) ON DELETE CASCADE,
  to_project_slug TEXT NOT NULL REFERENCES projects(project_slug) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_thread_id TEXT,
  source_turn_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_missions_updated ON missions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mission_projects_mission_updated ON mission_projects(mission_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mission_projects_project ON mission_projects(project_slug, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mission_project_dependencies_mission ON mission_project_dependencies(mission_id);
CREATE INDEX IF NOT EXISTS idx_mission_handoffs_mission_created ON mission_handoffs(mission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mission_handoffs_target_created ON mission_handoffs(mission_id, to_project_slug, created_at DESC);
