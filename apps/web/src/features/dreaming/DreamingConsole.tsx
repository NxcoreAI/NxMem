import React from "react";
import {
  controlDreamingRun,
  createDreamingRun,
  getDreamingRun,
  listDreamingRuns,
  type DreamingCandidateStatus,
  type DreamingRunCandidate,
  type DreamingRunDetails,
  type DreamingRunStatus,
  type DreamingRunSummary,
  type DreamingOwner,
  DEFAULT_DREAMING_OWNER
} from "./dreaming-api";

interface ShortTermMemoryPreview {
  memoryDataId: string;
  tenantId?: string;
  principalId?: string;
  content: string;
  summary?: string;
  factSummary?: string;
}

interface DreamingConsoleProps {
  shortTermMemories: ShortTermMemoryPreview[];
}

const activeStatuses = new Set<DreamingRunStatus>(["queued", "waiting_for_idle", "running", "pausing"]);

export function DreamingConsole({ shortTermMemories }: DreamingConsoleProps) {
  const ownerOptions = React.useMemo(() => collectOwners(shortTermMemories), [shortTermMemories]);
  const [owner, setOwner] = React.useState<DreamingOwner>(() => ownerOptions[0] ?? DEFAULT_DREAMING_OWNER);
  const [ownerTenantId, setOwnerTenantId] = React.useState(owner.tenantId);
  const [ownerPrincipalId, setOwnerPrincipalId] = React.useState(owner.principalId);
  const [runs, setRuns] = React.useState<DreamingRunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = React.useState("");
  const [details, setDetails] = React.useState<DreamingRunDetails | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [action, setAction] = React.useState<"pause" | "resume" | "cancel" | "create" | null>(null);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");

  const refreshRuns = React.useCallback(async (selectedOwner: DreamingOwner, quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const result = await listDreamingRuns(selectedOwner);
      const nextRuns = result.items ?? [];
      setRuns(nextRuns);
      setSelectedRunId((current) => current && nextRuns.some((run) => run.runId === current)
        ? current
        : nextRuns[0]?.runId ?? "");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取 Dreaming Run");
    } finally {
      if (!quiet) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  const refreshDetails = React.useCallback(async (runId: string, selectedOwner: DreamingOwner, quiet = false) => {
    if (!runId) {
      setDetails(null);
      return;
    }
    try {
      const next = await getDreamingRun(runId, selectedOwner);
      setDetails(next);
      setError("");
    } catch (cause) {
      if (!quiet) setError(cause instanceof Error ? cause.message : "无法读取 Run 详情");
    }
  }, []);

  React.useEffect(() => {
    void refreshRuns(owner);
  }, [owner, refreshRuns]);

  React.useEffect(() => {
    void refreshDetails(selectedRunId, owner);
  }, [owner, refreshDetails, selectedRunId]);

  React.useEffect(() => {
    const currentStatus = details?.run.status ?? runs.find((run) => run.runId === selectedRunId)?.status;
    if (!currentStatus || !activeStatuses.has(currentStatus)) return;
    const timer = window.setInterval(() => {
      void Promise.all([
        refreshRuns(owner, true),
        selectedRunId ? refreshDetails(selectedRunId, owner, true) : Promise.resolve()
      ]);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [details?.run.status, owner, refreshDetails, refreshRuns, runs, selectedRunId]);

  function applyOwner() {
    const tenantId = ownerTenantId.trim();
    const principalId = ownerPrincipalId.trim();
    if (!tenantId || !principalId) {
      setError("Tenant ID 和 Principal ID 不能为空");
      return;
    }
    const next = { tenantId, principalId };
    setRuns([]);
    setSelectedRunId("");
    setDetails(null);
    setError("");
    setNotice("");
    setOwner(next);
  }

  async function startRun() {
    setAction("create");
    setNotice("");
    try {
      const run = await createDreamingRun(owner);
      setNotice("已创建手动 Dreaming Run");
      setSelectedRunId(run.runId);
      await refreshRuns(owner, true);
      await refreshDetails(run.runId, owner, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建 Dreaming Run 失败");
    } finally {
      setAction(null);
    }
  }

  async function control(actionName: "pause" | "resume" | "cancel") {
    if (!selectedRunId) return;
    if (actionName === "cancel" && !window.confirm("确认取消当前 Dreaming Run？未处理 STM 会保留到后续窗口。")) return;
    setAction(actionName);
    setNotice("");
    try {
      await controlDreamingRun(selectedRunId, actionName, owner);
      setNotice(actionName === "pause" ? "Run 已请求暂停" : actionName === "resume" ? "Run 已恢复" : "Run 已取消");
      await Promise.all([refreshRuns(owner, true), refreshDetails(selectedRunId, owner, true)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dreaming 操作失败");
    } finally {
      setAction(null);
    }
  }

  const selectedDetails = details?.run.runId === selectedRunId ? details : null;
  const run = selectedDetails?.run ?? runs.find((item) => item.runId === selectedRunId);
  const candidates = selectedDetails?.candidates ?? [];
  const processed = run?.processedCount ?? 0;
  const total = run?.candidateCount ?? 0;
  const percent = total === 0 ? (run?.status === "completed" ? 100 : 0) : Math.min(100, Math.round((processed / total) * 100));
  const currentCandidate = candidates.find((candidate) => candidate.status === "processing");

  return (
    <section className="dreaming-console" aria-label="Dreaming 控制台">
      <div className="dreaming-toolbar">
        <div>
          <p className="eyebrow">后台巩固运行</p>
          <h2>Dreaming 控制台</h2>
        </div>
        <div className="button-row">
          <label className="dreaming-owner-control">
            <span>Tenant ID</span>
            <input
              value={ownerTenantId}
              onChange={(event) => setOwnerTenantId(event.target.value)}
              disabled={action !== null}
              aria-label="Dreaming Tenant ID"
              placeholder="local"
            />
          </label>
          <label className="dreaming-owner-control">
            <span>Principal ID</span>
            <input
              value={ownerPrincipalId}
              onChange={(event) => setOwnerPrincipalId(event.target.value)}
              disabled={action !== null}
              aria-label="Dreaming Principal ID"
              placeholder="local-user"
            />
          </label>
          <button className="secondary-action" onClick={applyOwner} disabled={action !== null} type="button">
            应用 Owner
          </button>
          <label className="dreaming-owner-presets">
            <span>已有 Owner</span>
            <select
              value={ownerKey(owner)}
              onChange={(event) => {
                const next = ownerOptions.find((item) => ownerKey(item) === event.target.value);
                if (!next) return;
                setOwnerTenantId(next.tenantId);
                setOwnerPrincipalId(next.principalId);
              }}
              disabled={action !== null}
              aria-label="已有 Dreaming Owner"
            >
              {ownerOptions.map((item) => (
                <option key={ownerKey(item)} value={ownerKey(item)}>{item.tenantId} / {item.principalId}</option>
              ))}
            </select>
          </label>
          <button className="secondary-action" onClick={() => void refreshRuns(owner)} disabled={refreshing || action !== null} type="button">
            {refreshing ? "刷新中..." : "刷新 Run"}
          </button>
          <button className="primary dreaming-start" onClick={() => void startRun()} disabled={action !== null} type="button">
            {action === "create" ? "创建中..." : "手动触发 Dreaming"}
          </button>
        </div>
      </div>

      {error ? <div className="dreaming-alert error" role="alert">{error}</div> : null}
      {notice ? <div className="dreaming-alert" role="status">{notice}</div> : null}

      <div className="dreaming-layout">
        <div className="dreaming-primary-column">
          {!run ? (
            <div className="empty-state">还没有 Dreaming Run。可手动触发一次巩固，或等待每天 23:00 的计划任务。</div>
          ) : (
            <>
              <section className="dreaming-panel dreaming-run-panel">
                <div className="panel-header">
                  <div>
                    <h3>当前 Run</h3>
                    <span className="dreaming-run-id">{run.runId}</span>
                  </div>
                  <span className={`dreaming-status status-${run.status}`}>{translateRunStatus(run.status)}</span>
                </div>
                <div className="dreaming-progress-meta">
                  <strong>{percent}%</strong>
                  <span>{processed} / {total} 条 STM 已检查</span>
                </div>
                <div className="dreaming-progress-track" aria-label={`Dreaming 进度 ${percent}%`}>
                  <span style={{ width: `${percent}%` }} />
                </div>
                <div className="dreaming-actions">
                  {run.status === "running" || run.status === "waiting_for_idle" ? (
                    <button onClick={() => void control("pause")} disabled={action !== null} type="button">暂停</button>
                  ) : null}
                  {run.status === "paused" || run.status === "pausing" ? (
                    <button onClick={() => void control("resume")} disabled={action !== null || run.status === "pausing"} type="button">恢复</button>
                  ) : null}
                  {activeStatuses.has(run.status) || run.status === "paused" ? (
                    <button className="danger-button" onClick={() => void control("cancel")} disabled={action !== null} type="button">取消</button>
                  ) : null}
                </div>
              </section>

              <section className="dreaming-stats-grid" aria-label="Dreaming 统计">
                <DreamingStat label="已处理" value={processed} />
                <DreamingStat label="待处理" value={Math.max(0, total - processed)} />
                <DreamingStat label="已巩固" value={run.consolidatedCount} />
                <DreamingStat label="观察" value={run.observingCount} />
                <DreamingStat label="重试" value={run.retryWaitCount} />
                <DreamingStat label="跳过" value={run.skippedCount} />
              </section>

              <section className="dreaming-panel dreaming-context-grid">
                <div>
                  <span className="dreaming-label">候选窗口</span>
                  <strong>{formatWindow(run.candidateWindowStartAt, run.candidateCutoffAt)}</strong>
                </div>
                <div>
                  <span className="dreaming-label">当前正在处理的 STM</span>
                  {currentCandidate ? (
                    <strong>{previewMemory(currentCandidate.memoryDataId, shortTermMemories)}</strong>
                  ) : <span className="dreaming-muted">当前没有正在处理的 STM</span>}
                </div>
              </section>

              <section className="dreaming-panel">
                <div className="panel-header">
                  <h3>STM 逐条处理列表</h3>
                  <span>{candidates.length} 条候选</span>
                </div>
                {candidates.length ? (
                  <div className="dreaming-candidate-list">
                    {candidates.map((candidate) => (
                      <DreamingCandidateRow key={candidate.runCandidateId} candidate={candidate} memories={shortTermMemories} />
                    ))}
                  </div>
                ) : <div className="empty-state small">详情加载后会显示本次 Run 的 STM 候选。</div>}
              </section>

              {selectedDetails?.run.lastError ? (
                <section className="dreaming-panel dreaming-error-panel">
                  <div className="panel-header"><h3>最近错误和重试原因</h3><span>{formatTime(selectedDetails.run.updatedAt)}</span></div>
                  <p>{selectedDetails.run.lastError}</p>
                </section>
              ) : null}
            </>
          )}
        </div>

        <aside className="dreaming-history-column">
          <section className="dreaming-panel">
            <div className="panel-header"><h3>观察项下一次评估</h3><span>按时间排序</span></div>
            <ObservationList candidates={candidates} memories={shortTermMemories} />
          </section>
          <section className="dreaming-panel dreaming-history-panel">
            <div className="panel-header"><h3>最近历史 Run</h3><span>{runs.length} 次</span></div>
            {loading ? <div className="dreaming-muted">正在加载...</div> : runs.length ? (
              <div className="dreaming-history-list">
                {runs.map((item) => (
                  <button className={`dreaming-history-row ${item.runId === selectedRunId ? "active" : ""}`} key={item.runId} onClick={() => setSelectedRunId(item.runId)} type="button">
                    <span><strong>{item.triggerType === "manual" ? "手动" : "计划"}</strong><small>{formatTime(item.candidateCutoffAt)}</small></span>
                    <span><b>{translateRunStatus(item.status)}</b><small>{item.processedCount}/{item.candidateCount} 条</small></span>
                  </button>
                ))}
              </div>
            ) : <div className="empty-state small">暂无历史 Run</div>}
          </section>
        </aside>
      </div>
    </section>
  );
}

function DreamingStat({ label, value }: { label: string; value: number }) {
  return <div className="dreaming-stat"><span>{label}</span><strong>{value}</strong></div>;
}

function DreamingCandidateRow({ candidate, memories }: { candidate: DreamingRunCandidate; memories: ShortTermMemoryPreview[] }) {
  return (
    <div className={`dreaming-candidate-row candidate-${candidate.status}`}>
      <div className="dreaming-candidate-main">
        <strong>{previewMemory(candidate.memoryDataId, memories)}</strong>
        <small>{candidate.memoryDataId} · {candidate.sourceType}</small>
      </div>
      <span className={`dreaming-status status-${candidate.status}`}>{translateCandidateStatus(candidate.status)}</span>
      <div className="dreaming-candidate-meta">
        <span>本周期 {candidate.cycleAttemptCount} 次</span>
        {candidate.nextEvaluateAt ? <span>下次 {formatTime(candidate.nextEvaluateAt)}</span> : null}
        {candidate.lastError ? <span className="dreaming-error-text">{candidate.lastError}</span> : null}
      </div>
    </div>
  );
}

function ObservationList({ candidates, memories }: { candidates: DreamingRunCandidate[]; memories: ShortTermMemoryPreview[] }) {
  const observing = candidates.filter((candidate) => candidate.status === "observing").sort((a, b) => (a.nextEvaluateAt ?? "").localeCompare(b.nextEvaluateAt ?? ""));
  if (!observing.length) return <div className="dreaming-muted">本次 Run 没有待观察 STM。</div>;
  return <div className="dreaming-observation-list">{observing.map((candidate) => <div className="dreaming-observation-row" key={candidate.runCandidateId}><strong>{previewMemory(candidate.memoryDataId, memories)}</strong><span>{candidate.nextEvaluateAt ? formatTime(candidate.nextEvaluateAt) : "未设置"}</span></div>)}</div>;
}

function previewMemory(memoryDataId: string, memories: ShortTermMemoryPreview[]) {
  const memory = memories.find((item) => item.memoryDataId === memoryDataId);
  if (!memory) return memoryDataId;
  return (memory.summary || memory.factSummary || memory.content || memoryDataId).slice(0, 120);
}

function formatWindow(start: string, cutoff: string) {
  return `${formatTime(start)} 到 ${formatTime(cutoff)}`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function translateRunStatus(status: DreamingRunStatus) {
  return ({ queued: "排队中", waiting_for_idle: "等待空闲", running: "运行中", pausing: "暂停中", paused: "已暂停", completed: "已完成", cancelled: "已取消", failed: "失败" } as Record<DreamingRunStatus, string>)[status];
}

function translateCandidateStatus(status: DreamingCandidateStatus) {
  return ({ pending: "待处理", processing: "处理中", consolidated: "已巩固", observing: "观察中", dropped: "已释放", retry_wait: "等待重试", skipped: "已跳过" } as Record<DreamingCandidateStatus, string>)[status];
}

function collectOwners(memories: ShortTermMemoryPreview[]) {
  const owners = new Map<string, DreamingOwner>();
  for (const memory of memories) {
    if (!memory.tenantId?.trim() || !memory.principalId?.trim()) continue;
    const owner = { tenantId: memory.tenantId.trim(), principalId: memory.principalId.trim() };
    owners.set(ownerKey(owner), owner);
  }
  if (!owners.size) owners.set(ownerKey(DEFAULT_DREAMING_OWNER), DEFAULT_DREAMING_OWNER);
  return [...owners.values()].sort((left, right) => ownerKey(left).localeCompare(ownerKey(right)));
}

function ownerKey(owner: DreamingOwner) {
  return `${owner.tenantId}\u0000${owner.principalId}`;
}
