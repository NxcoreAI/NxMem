CREATE TABLE IF NOT EXISTS context_engine_migrations (
  version TEXT PRIMARY KEY,
  migration_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  counts_json TEXT NOT NULL DEFAULT '{}',
  errors_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS memory_events (
  event_id TEXT PRIMARY KEY,
  context_scope_id TEXT,
  event_type TEXT NOT NULL,
  event_summary TEXT,
  event_description TEXT,
  event_time TEXT NOT NULL,
  source_app TEXT,
  source_id TEXT,
  data_source TEXT,
  custom_fields TEXT NOT NULL DEFAULT '{}',
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  source_acl_version TEXT NOT NULL,
  visibility TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS multimodal_data_items (
  item_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  source_item_id TEXT,
  type TEXT NOT NULL,
  format TEXT NOT NULL,
  content TEXT,
  ref TEXT,
  source_ref TEXT,
  source_refs TEXT,
  time_basis TEXT,
  time_confidence TEXT,
  custom_fields TEXT NOT NULL DEFAULT '{}',
  lifecycle_status TEXT NOT NULL DEFAULT 'raw'
);

CREATE TABLE IF NOT EXISTS permission_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  source_acl_version TEXT NOT NULL,
  visibility TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS source_refs (
  source_ref_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_url TEXT
);

CREATE TABLE IF NOT EXISTS event_source_refs (
  event_id TEXT NOT NULL,
  source_ref_id TEXT NOT NULL,
  PRIMARY KEY (event_id, source_ref_id)
);

CREATE TABLE IF NOT EXISTS fact_items (
  fact_id TEXT PRIMARY KEY,
  session_id TEXT,
  fact_sequence INTEGER,
  tenant_id TEXT,
  principal_id TEXT,
  context_scope_id TEXT,
  fact_type TEXT NOT NULL,
  fact_text TEXT NOT NULL,
  time_anchor TEXT,
  source_claim TEXT,
  normalized_claim TEXT NOT NULL,
  linked_event_ids TEXT NOT NULL DEFAULT '[]',
  linked_segment_ids TEXT NOT NULL DEFAULT '[]',
  linked_source_refs TEXT NOT NULL DEFAULT '[]',
  entity_ids TEXT NOT NULL DEFAULT '[]',
  confidence_level TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  observed_at TEXT NOT NULL,
  evidence_time TEXT,
  valid_time TEXT,
  temporal_events TEXT NOT NULL DEFAULT '[]',
  evidence_time_start TEXT,
  evidence_time_end TEXT,
  evidence_time_confidence TEXT NOT NULL DEFAULT 'low',
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  valid_time_start TEXT,
  valid_time_end TEXT,
  valid_time_basis TEXT,
  valid_time_confidence TEXT NOT NULL DEFAULT 'low',
  time_basis TEXT NOT NULL,
  time_confidence TEXT NOT NULL,
  schema_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fact_versions (
  fact_version_id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  previous_version_id TEXT,
  fact_text TEXT NOT NULL,
  normalized_claim TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  evidence_time_start TEXT,
  evidence_time_end TEXT,
  valid_time_start TEXT,
  valid_time_end TEXT,
  confidence_level TEXT NOT NULL,
  source_fact_ids TEXT NOT NULL DEFAULT '[]',
  linked_event_ids TEXT NOT NULL DEFAULT '[]',
  linked_segment_ids TEXT NOT NULL DEFAULT '[]',
  linked_source_refs TEXT NOT NULL DEFAULT '[]',
  update_reason TEXT NOT NULL,
  conflict_refs TEXT NOT NULL DEFAULT '[]',
  source_fingerprint TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (fact_id) REFERENCES fact_items(fact_id) ON DELETE CASCADE,
  FOREIGN KEY (previous_version_id) REFERENCES fact_versions(fact_version_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_versions_owner_fact_version
  ON fact_versions(tenant_id, principal_id, fact_id, version);

CREATE INDEX IF NOT EXISTS idx_fact_versions_previous_version
  ON fact_versions(previous_version_id);

CREATE INDEX IF NOT EXISTS idx_fact_versions_owner_evidence_time
  ON fact_versions(tenant_id, principal_id, evidence_time_start, evidence_time_end, fact_id);

CREATE INDEX IF NOT EXISTS idx_fact_versions_owner_valid_time
  ON fact_versions(tenant_id, principal_id, valid_time_start, valid_time_end, fact_id);

CREATE TABLE IF NOT EXISTS fact_batches (
  batch_id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  context_scope_id TEXT,
  new_fact_ids TEXT NOT NULL,
  committed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fact_batches_owner_committed
  ON fact_batches(tenant_id, principal_id, committed_at, batch_id);

CREATE TABLE IF NOT EXISTS timeline_fusion_tasks (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  context_scope_id TEXT,
  batch_ids TEXT NOT NULL,
  new_fact_ids TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  ready_at TEXT,
  execution_fingerprints TEXT NOT NULL DEFAULT '[]',
  completion_reason TEXT,
  completed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timeline_fusion_tasks_owner_status_schedule
  ON timeline_fusion_tasks(tenant_id, principal_id, status, scheduled_at, task_id);

CREATE TABLE IF NOT EXISTS timeline_fusion_executions (
  fingerprint TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  context_scope_id TEXT,
  task_ids TEXT NOT NULL,
  batch_ids TEXT NOT NULL,
  new_fact_ids TEXT NOT NULL,
  temporal_basis TEXT NOT NULL,
  temporal_start_at TEXT NOT NULL,
  temporal_end_at TEXT NOT NULL,
  fusion_policy_version TEXT NOT NULL,
  status TEXT NOT NULL,
  result_fact_ids TEXT NOT NULL DEFAULT '[]',
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  completion_reason TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_timeline_fusion_executions_owner_status_updated
  ON timeline_fusion_executions(tenant_id, principal_id, status, updated_at, fingerprint);

CREATE TABLE IF NOT EXISTS short_term_memories (
  memory_data_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  memory_data_type TEXT NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'fact',
  content TEXT NOT NULL,
  structured_facts TEXT,
  fact_summary TEXT,
  summary TEXT,
  evidence_time TEXT,
  valid_time TEXT,
  evidence_time_start TEXT,
  evidence_time_end TEXT,
  evidence_time_confidence TEXT NOT NULL DEFAULT 'low',
  valid_time_start TEXT,
  valid_time_end TEXT,
  valid_time_confidence TEXT NOT NULL DEFAULT 'low',
  importance_level TEXT NOT NULL,
  retrieval_weight REAL NOT NULL DEFAULT 0.2,
  user_retrieval_weight REAL,
  confidence_level TEXT NOT NULL,
  admission_result TEXT NOT NULL,
  admission_reason TEXT NOT NULL,
  source_fact_ids TEXT NOT NULL DEFAULT '[]',
  source_refs TEXT NOT NULL DEFAULT '[]',
  entity_ids TEXT NOT NULL DEFAULT '[]',
  matched_rules TEXT NOT NULL DEFAULT '[]',
  admission_signals TEXT NOT NULL DEFAULT '{}',
  access_state TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  consolidation_status TEXT NOT NULL DEFAULT 'unseen',
  next_evaluate_at TEXT,
  last_evaluated_at TEXT,
  observe_count INTEGER NOT NULL DEFAULT 0,
  reevaluation_reason TEXT,
  expires_at TEXT,
  dreaming_policy_version TEXT,
  latest_decision_id TEXT,
  reevaluation_tier TEXT,
  cycle_attempt_count INTEGER NOT NULL DEFAULT 0,
  total_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_dreaming_error TEXT,
  latest_dreaming_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dreaming_candidate_decisions (
  decision_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  candidate_fingerprint TEXT NOT NULL,
  memory_data_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_codes TEXT NOT NULL DEFAULT '[]',
  source_fact_ids TEXT NOT NULL DEFAULT '[]',
  source_refs TEXT NOT NULL DEFAULT '[]',
  permission_snapshot_ids TEXT NOT NULL DEFAULT '[]',
  policy_version TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  next_evaluate_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dreaming_candidate_decisions_memory
  ON dreaming_candidate_decisions(tenant_id, principal_id, memory_data_id, created_at);

CREATE TABLE IF NOT EXISTS dreaming_runs (
  run_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  schedule_key TEXT,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  candidate_window_start_at TEXT NOT NULL,
  candidate_cutoff_at TEXT NOT NULL,
  actual_started_at TEXT,
  paused_at TEXT,
  pause_reason TEXT,
  completed_at TEXT,
  checkpoint TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  policy_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  consolidated_count INTEGER NOT NULL DEFAULT 0,
  observing_count INTEGER NOT NULL DEFAULT 0,
  dropped_count INTEGER NOT NULL DEFAULT 0,
  retry_wait_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dreaming_runs_scheduled_once
  ON dreaming_runs(tenant_id, principal_id, schedule_key)
  WHERE trigger_type = 'scheduled' AND schedule_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dreaming_runs_owner_status
  ON dreaming_runs(tenant_id, principal_id, status, candidate_cutoff_at);

CREATE TABLE IF NOT EXISTS dreaming_run_candidates (
  run_candidate_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  memory_data_id TEXT NOT NULL,
  stm_version TEXT NOT NULL,
  candidate_fingerprint TEXT NOT NULL,
  source_type TEXT NOT NULL,
  status TEXT NOT NULL,
  cycle_attempt_count INTEGER NOT NULL DEFAULT 0,
  total_attempt_count INTEGER NOT NULL DEFAULT 0,
  reevaluation_tier TEXT,
  next_evaluate_at TEXT,
  decision_id TEXT,
  trace_id TEXT,
  result_ltm_id TEXT,
  last_error TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, memory_data_id, candidate_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_dreaming_run_candidates_run_status
  ON dreaming_run_candidates(run_id, status, created_at, memory_data_id);

CREATE INDEX IF NOT EXISTS idx_dreaming_run_candidates_memory
  ON dreaming_run_candidates(memory_data_id, status, next_evaluate_at);

CREATE TABLE IF NOT EXISTS long_term_memories (
  memory_id TEXT PRIMARY KEY,
  tenant_id TEXT,
  principal_id TEXT,
  consolidation_key TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  previous_version_id TEXT,
  consolidation_score REAL,
  consolidation_factors TEXT,
  policy_version TEXT,
  prompt_version TEXT,
  model TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_maintained_at TEXT,
  theory_class TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  content TEXT NOT NULL,
  structured_facts TEXT,
  fact_summary TEXT,
  summary TEXT,
  evidence_time_start TEXT,
  evidence_time_end TEXT,
  evidence_time_confidence TEXT NOT NULL DEFAULT 'low',
  valid_time_start TEXT,
  valid_time_end TEXT,
  valid_time_confidence TEXT NOT NULL DEFAULT 'low',
  confidence_level TEXT NOT NULL,
  recall_weight TEXT NOT NULL,
  retrieval_weight REAL NOT NULL DEFAULT 0.3,
  user_retrieval_weight REAL,
  solidify_reason TEXT NOT NULL,
  source_refs TEXT NOT NULL DEFAULT '[]',
  source_memory_data_ids TEXT NOT NULL DEFAULT '[]',
  source_fact_ids TEXT NOT NULL DEFAULT '[]',
  entity_ids TEXT NOT NULL DEFAULT '[]',
  matched_rules TEXT NOT NULL DEFAULT '[]',
  access_state TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS relation_edges (
  edge_id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  evidence TEXT,
  strength REAL,
  confidence TEXT,
  source TEXT,
  created_at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS context_text_index_fts USING fts5(
  index_id UNINDEXED,
  owner_id UNINDEXED,
  owner_type UNINDEXED,
  term,
  document_frequency UNINDEXED,
  term_frequency UNINDEXED,
  document_length UNINDEXED,
  lifecycle_status UNINDEXED,
  refreshed_at UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS context_vector_index_entries (
  index_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  content TEXT NOT NULL,
  vector TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  refreshed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_memory_nodes (
  graph_node_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  memory_type TEXT,
  content TEXT NOT NULL,
  fact_summary TEXT,
  vector TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  retrieval_weight REAL NOT NULL DEFAULT 0.3,
  source_refs TEXT NOT NULL DEFAULT '[]',
  entity_ids TEXT NOT NULL DEFAULT '[]',
  evidence_time_start TEXT,
  evidence_time_end TEXT,
  evidence_time_confidence TEXT NOT NULL DEFAULT 'low',
  valid_time_start TEXT,
  valid_time_end TEXT,
  valid_time_confidence TEXT NOT NULL DEFAULT 'low',
  refreshed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_pack_traces (
  trace_id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  final_score REAL NOT NULL DEFAULT 0,
  token_budget INTEGER NOT NULL DEFAULT 0,
  temporal_trace TEXT
);

CREATE TABLE IF NOT EXISTS llm_fact_fusion_traces (
  trace_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  key_source TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  prompt TEXT NOT NULL,
  aligned_evidence TEXT NOT NULL DEFAULT '[]',
  raw_response TEXT,
  parsed_facts TEXT NOT NULL DEFAULT '[]',
  rejected_segments TEXT NOT NULL DEFAULT '[]',
  fallback_reason TEXT,
  temporal_trace TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_stm_admission_traces (
  trace_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  key_source TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  prompt TEXT NOT NULL,
  fact_inputs TEXT NOT NULL DEFAULT '[]',
  raw_response TEXT,
  parsed_decision TEXT,
  fallback_reason TEXT,
  override_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_dreaming_traces (
  trace_id TEXT PRIMARY KEY,
  source_memory_data_ids TEXT NOT NULL DEFAULT '[]',
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  key_source TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  prompt TEXT NOT NULL,
  candidate_memories TEXT NOT NULL DEFAULT '[]',
  raw_response TEXT,
  parsed_memories TEXT NOT NULL DEFAULT '[]',
  stm_evaluations TEXT NOT NULL DEFAULT '[]',
  ltm_operations TEXT NOT NULL DEFAULT '[]',
  rejected_candidates TEXT NOT NULL DEFAULT '[]',
  fallback_reason TEXT,
  retry_after TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_pipeline_tasks (
  task_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  retryable INTEGER NOT NULL DEFAULT 1,
  stage TEXT NOT NULL,
  error TEXT,
  retry_after TEXT,
  checkpoint TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  stats TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dreaming_outbox (
  outbox_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dreaming_outbox_pending
  ON dreaming_outbox(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS context_index_entries (
  index_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  content TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  token_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_change_events (
  event_id TEXT PRIMARY KEY,
  memory_id TEXT,
  memory_data_id TEXT,
  change_type TEXT NOT NULL,
  storage_layer TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memory_feedback_items (
  feedback_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  action TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_retrieval_events (
  retrieval_event_id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  tenant_id TEXT,
  principal_id TEXT,
  session_id TEXT,
  task_id TEXT,
  request_id TEXT,
  event_type TEXT NOT NULL,
  query TEXT,
  feedback_action TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_retrieval_events_request_owner
  ON memory_retrieval_events(request_id, owner_type, owner_id, event_type)
  WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_retrieval_events_owner_time
  ON memory_retrieval_events(owner_type, owner_id, created_at);

CREATE TABLE IF NOT EXISTS background_context_documents (
  background_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  fixed_text TEXT NOT NULL,
  dynamic_text TEXT NOT NULL,
  fixed_revision INTEGER NOT NULL CHECK (fixed_revision > 0),
  fixed_text_updated_at TEXT NOT NULL,
  fixed_watermark_json TEXT NOT NULL,
  dynamic_window_start TEXT NOT NULL,
  dynamic_window_end TEXT NOT NULL,
  dynamic_source_memory_ids_json TEXT NOT NULL,
  latest_stm_cursor_json TEXT NOT NULL,
  dynamic_cache_key TEXT,
  source_ref_ids TEXT NOT NULL,
  conflict_ids TEXT NOT NULL,
  degraded_mode_reason TEXT,
  update_suggestion_status TEXT,
  update_suggestion_summary TEXT,
  update_suggestion_target_sections TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS background_maintenance_tasks (
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  execution_strategy TEXT NOT NULL,
  base_background_id TEXT,
  base_revision INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  through_cursor_json TEXT,
  checkpoint_cursor_json TEXT,
  section_accumulator_json TEXT,
  scanned_page_count INTEGER NOT NULL DEFAULT 0,
  llm_analysis_call_count INTEGER NOT NULL DEFAULT 0,
  processed_memory_count INTEGER NOT NULL DEFAULT 0,
  ignored_memory_count INTEGER NOT NULL DEFAULT 0,
  deferred_ranges_json TEXT NOT NULL DEFAULT '[]',
  deferred_memory_count INTEGER NOT NULL DEFAULT 0,
  input_token_usage INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  retryable INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  result_json TEXT,
  claimed_by TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, principal_id, run_id)
);

CREATE TABLE IF NOT EXISTS background_maintenance_batches (
  task_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  through_cursor_json TEXT NOT NULL,
  memory_ids_json TEXT NOT NULL,
  memory_source_refs_json TEXT NOT NULL,
  memory_count INTEGER NOT NULL,
  analysis_output_json TEXT NOT NULL,
  estimated_input_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, batch_index),
  FOREIGN KEY (task_id) REFERENCES background_maintenance_tasks(task_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_background_maintenance_owner_status
  ON background_maintenance_tasks(tenant_id, principal_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_background_maintenance_lease
  ON background_maintenance_tasks(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS background_dynamic_cache (
  cache_key TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  fixed_background_id TEXT NOT NULL,
  fixed_revision INTEGER NOT NULL,
  latest_stm_cursor_json TEXT NOT NULL,
  reference_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  locale TEXT NOT NULL,
  local_date TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  dynamic_text TEXT NOT NULL,
  source_memory_ids_json TEXT NOT NULL,
  source_ref_ids_json TEXT NOT NULL,
  citations_json TEXT NOT NULL,
  conflict_ids_json TEXT NOT NULL,
  processed_memory_count INTEGER NOT NULL,
  pending_stm_count INTEGER NOT NULL,
  deferred_memory_count INTEGER NOT NULL,
  deferred_ranges_json TEXT NOT NULL,
  watermark_lag_seconds INTEGER NOT NULL,
  execution_strategy TEXT NOT NULL,
  status TEXT NOT NULL,
  degraded_mode_reason TEXT,
  generated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dynamic_cache_owner
  ON background_dynamic_cache(tenant_id, principal_id, fixed_revision, generated_at);

CREATE INDEX IF NOT EXISTS idx_dynamic_cache_expiry
  ON background_dynamic_cache(expires_at);

CREATE TABLE IF NOT EXISTS session_background_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  background_id TEXT NOT NULL,
  fixed_revision INTEGER NOT NULL,
  fixed_text TEXT NOT NULL,
  dynamic_text TEXT NOT NULL,
  dynamic_window_start TEXT NOT NULL,
  dynamic_window_end TEXT NOT NULL,
  reference_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  locale TEXT NOT NULL,
  local_date TEXT NOT NULL,
  fixed_source_ref_ids_json TEXT NOT NULL,
  dynamic_source_ref_ids_json TEXT NOT NULL,
  source_memory_ids_json TEXT NOT NULL,
  citations_json TEXT NOT NULL,
  conflict_ids_json TEXT NOT NULL,
  latest_stm_cursor_json TEXT NOT NULL,
  dynamic_cache_key TEXT NOT NULL,
  cache_hit INTEGER NOT NULL,
  execution_strategy TEXT NOT NULL,
  processed_memory_count INTEGER NOT NULL,
  pending_stm_count INTEGER NOT NULL,
  deferred_memory_count INTEGER NOT NULL,
  watermark_lag_seconds INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  degraded_mode_reason TEXT,
  serialized_prompt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_background_owner_session
  ON session_background_snapshots(tenant_id, principal_id, session_id, created_at);

CREATE TABLE IF NOT EXISTS parsed_segments (
  segment_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  modality TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  data_source TEXT,
  custom_fields TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS conversation_batch_ingestions (
  batch_ingestion_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  document_sha256 TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  source_app TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  document_status TEXT NOT NULL,
  processing_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, source_app, principal_id, idempotency_key),
  UNIQUE (tenant_id, source_app, principal_id, batch_id)
);

CREATE TABLE IF NOT EXISTS conversation_ingestions (
  ingestion_id TEXT PRIMARY KEY,
  batch_ingestion_id TEXT,
  idempotency_key TEXT NOT NULL,
  document_sha256 TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_app TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  visibility TEXT NOT NULL,
  timezone TEXT,
  locale TEXT,
  temporal_mode TEXT NOT NULL DEFAULT 'legacy',
  previous_cursor TEXT,
  committed_cursor TEXT NOT NULL,
  first_sequence INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  document_status TEXT NOT NULL,
  processing_status TEXT NOT NULL,
  processing_stage TEXT NOT NULL,
  processing_mode TEXT NOT NULL,
  progress_percent INTEGER NOT NULL DEFAULT 0,
  message_counts TEXT NOT NULL,
  layer_counts TEXT NOT NULL,
  retry_state TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, source_app, idempotency_key),
  UNIQUE (tenant_id, source_app, principal_id, session_id, batch_id),
  FOREIGN KEY (batch_ingestion_id) REFERENCES conversation_batch_ingestions(batch_ingestion_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_documents (
  document_id TEXT PRIMARY KEY,
  batch_ingestion_id TEXT UNIQUE,
  ingestion_id TEXT UNIQUE,
  schema_version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  raw_markdown TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (batch_ingestion_id) REFERENCES conversation_batch_ingestions(batch_ingestion_id) ON DELETE CASCADE,
  FOREIGN KEY (ingestion_id) REFERENCES conversation_ingestions(ingestion_id) ON DELETE CASCADE,
  CHECK (batch_ingestion_id IS NOT NULL OR ingestion_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  conversation_message_row_id TEXT PRIMARY KEY,
  first_ingestion_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  source_app TEXT NOT NULL,
  session_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  content_type TEXT NOT NULL DEFAULT 'text/markdown',
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  reply_to_message_id TEXT,
  parent_message_id TEXT,
  branch_id TEXT NOT NULL DEFAULT 'main',
  tool_call_id TEXT,
  tool_name TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  operation TEXT NOT NULL DEFAULT 'append',
  metadata TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  timezone TEXT,
  locale TEXT,
  time_confidence TEXT NOT NULL,
  stored_at TEXT NOT NULL,
  UNIQUE (tenant_id, principal_id, source_app, session_id, message_id, revision),
  UNIQUE (tenant_id, principal_id, source_app, session_id, sequence, branch_id, revision),
  FOREIGN KEY (first_ingestion_id) REFERENCES conversation_ingestions(ingestion_id)
);

CREATE TABLE IF NOT EXISTS conversation_document_messages (
  document_id TEXT NOT NULL,
  ingestion_id TEXT NOT NULL,
  conversation_message_row_id TEXT NOT NULL,
  message_order INTEGER NOT NULL,
  PRIMARY KEY (document_id, ingestion_id, conversation_message_row_id),
  UNIQUE (document_id, ingestion_id, message_order),
  FOREIGN KEY (document_id) REFERENCES conversation_documents(document_id) ON DELETE CASCADE,
  FOREIGN KEY (ingestion_id) REFERENCES conversation_ingestions(ingestion_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_message_row_id) REFERENCES conversation_messages(conversation_message_row_id)
);

CREATE TABLE IF NOT EXISTS conversation_session_cursors (
  tenant_id TEXT NOT NULL,
  source_app TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  committed_cursor TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  last_ingestion_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, source_app, principal_id, session_id),
  FOREIGN KEY (last_ingestion_id) REFERENCES conversation_ingestions(ingestion_id)
);

CREATE TABLE IF NOT EXISTS conversation_ingestion_jobs (
  job_id TEXT PRIMARY KEY,
  ingestion_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  retryable INTEGER NOT NULL,
  retry_after TEXT,
  claimed_by TEXT,
  claimed_at TEXT,
  heartbeat_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (ingestion_id) REFERENCES conversation_ingestions(ingestion_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_events_tenant_principal
  ON memory_events(tenant_id, principal_id);

CREATE INDEX IF NOT EXISTS idx_fact_items_status_version
  ON fact_items(status, version);

CREATE INDEX IF NOT EXISTS idx_stm_lifecycle
  ON short_term_memories(lifecycle_status);

CREATE INDEX IF NOT EXISTS idx_ltm_lifecycle
  ON long_term_memories(lifecycle_status);

CREATE INDEX IF NOT EXISTS idx_relation_edges_from_to
  ON relation_edges(from_id, to_id);

CREATE INDEX IF NOT EXISTS idx_vector_index_entries_owner
  ON context_vector_index_entries(owner_type, owner_id);

CREATE INDEX IF NOT EXISTS idx_graph_memory_nodes_owner
  ON graph_memory_nodes(owner_type, owner_id);

CREATE INDEX IF NOT EXISTS idx_memory_change_events_created_at
  ON memory_change_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_pipeline_tasks_event_status
  ON context_pipeline_tasks(event_id, status);

CREATE INDEX IF NOT EXISTS idx_context_index_entries_owner
  ON context_index_entries(owner_type, owner_id);

CREATE INDEX IF NOT EXISTS idx_llm_fact_fusion_traces_event
  ON llm_fact_fusion_traces(event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_stm_admission_traces_event
  ON llm_stm_admission_traces(event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_dreaming_traces_created_at
  ON llm_dreaming_traces(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_ingestions_session
  ON conversation_ingestions(tenant_id, source_app, principal_id, session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_conversation_jobs_status
  ON conversation_ingestion_jobs(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_memory_events_owner_time
  ON memory_events(tenant_id, principal_id, event_time, event_id);

CREATE INDEX IF NOT EXISTS idx_parsed_segments_event
  ON parsed_segments(event_id, segment_id);
