export interface MemoryIngestionProgressState {
  label: string;
  stage: "event" | "data_lake" | "timeline_aggregation" | "ltm" | "stm" | "done";
  percent: number;
  details: string;
}

export type ManualStepAction = "event" | "data_lake" | "timeline_fusion" | "stm" | "ltm";

export interface MemoryProgressStep {
  label: string;
  stage: MemoryIngestionProgressState["stage"];
  percent: number;
  details: string;
  status: "pending" | "active" | "complete" | "error";
}

export interface ManualMemoryFlowResultLike {
  event: { eventType: string };
  dataLake: { parsedSegments: number; facts: number };
  timelineAggregation: { aggregatedFacts: Array<unknown> };
  longTermMemory: { memoryId: string };
  shortTermMemory: { memoryDataId: string };
}

export function buildProgressStages(result: ManualMemoryFlowResultLike): MemoryIngestionProgressState[] {
  return [
    { label: "写入事件", stage: "event", percent: 12, details: result.event.eventType },
    {
      label: "解析为数据湖",
      stage: "data_lake",
      percent: 35,
      details: `${result.dataLake.parsedSegments} 个片段 / ${result.dataLake.facts} 条事实`
    },
    {
      label: "时间轴聚合",
      stage: "timeline_aggregation",
      percent: 58,
      details: `${result.timelineAggregation.aggregatedFacts.length} 条聚合事实`
    },
    { label: "长期记忆", stage: "ltm", percent: 78, details: result.longTermMemory.memoryId },
    { label: "短期记忆", stage: "stm", percent: 100, details: result.shortTermMemory.memoryDataId }
  ];
}

export function translateMemoryProgressStage(stage: MemoryIngestionProgressState["stage"]) {
  const labels: Record<MemoryIngestionProgressState["stage"], string> = {
    event: "事件",
    data_lake: "数据湖",
    timeline_aggregation: "时间轴聚合",
    ltm: "长期记忆",
    stm: "短期记忆",
    done: "完成"
  };
  return labels[stage];
}

export function translateManualStepStage(action: ManualStepAction) {
  const labels: Record<typeof action, string> = {
    event: "写入事件",
    data_lake: "解析为数据湖",
    timeline_fusion: "时间轴融合",
    stm: "短期记忆准入",
    ltm: "长期记忆巩固"
  };
  return labels[action];
}

export function translateManualStepDetails(action: ManualStepAction) {
  const details: Record<typeof action, string> = {
    event: "正在创建 MemoryEvent",
    data_lake: "正在生成解析片段",
    timeline_fusion: "正在抽取事实并融合",
    stm: "正在评估准入规则",
    ltm: "正在做梦并巩固长期记忆"
  };
  return details[action];
}

export function buildManualStepProgress(action: ManualStepAction, completed = false): {
  current: MemoryIngestionProgressState;
  steps: MemoryProgressStep[];
} {
  const stepStage = manualStepStage(action);
  const percent = completed ? 100 : manualStepActivePercent(action);
  const details = completed ? translateManualStepSuccessDetails(action) : translateManualStepDetails(action);
  const activeSteps = buildManualStepProgressSteps(action);
  return {
    current: {
      label: completed ? translateManualStepSuccessStage(action) : translateManualStepStage(action),
      stage: completed ? "done" : stepStage,
      percent,
      details
    },
    steps: completed
      ? activeSteps.map((step) => ({
          ...step,
          status: step.status === "active" ? "complete" : step.status
        }))
      : activeSteps
  };
}

function buildManualStepProgressSteps(action: ManualStepAction): MemoryProgressStep[] {
  return [
    { label: "写入事件", stage: "event", percent: 12, details: "正在创建 MemoryEvent", status: action === "event" ? "active" : "pending" },
    { label: "数据湖 / 解析", stage: "data_lake", percent: 35, details: "正在生成解析片段", status: action === "data_lake" ? "active" : action === "timeline_fusion" || action === "stm" || action === "ltm" ? "complete" : "pending" },
    { label: "时间轴 / 融合", stage: "timeline_aggregation", percent: 58, details: "正在抽取事实并融合", status: action === "timeline_fusion" ? "active" : action === "stm" || action === "ltm" ? "complete" : "pending" },
    { label: "长期记忆 / LTM", stage: "ltm", percent: 78, details: "正在做梦并巩固长期记忆", status: action === "ltm" ? "active" : "pending" },
    { label: "短期记忆 / STM", stage: "stm", percent: 100, details: "正在回灌并建立可召回上下文", status: action === "stm" ? "active" : action === "ltm" ? "complete" : "pending" }
  ];
}

function manualStepStage(action: ManualStepAction): MemoryIngestionProgressState["stage"] {
  return action === "event" ? "event" : action === "data_lake" ? "data_lake" : action === "timeline_fusion" ? "timeline_aggregation" : action === "stm" ? "stm" : "ltm";
}

function manualStepActivePercent(action: ManualStepAction) {
  return action === "event" ? 12 : action === "data_lake" ? 35 : action === "timeline_fusion" ? 58 : action === "stm" ? 78 : 100;
}

function translateManualStepSuccessStage(action: ManualStepAction) {
  const labels: Record<ManualStepAction, string> = {
    event: "事件写入完成",
    data_lake: "数据湖解析完成",
    timeline_fusion: "时间轴融合完成",
    stm: "短期记忆准入完成",
    ltm: "长期记忆巩固完成"
  };
  return labels[action];
}

function translateManualStepSuccessDetails(action: ManualStepAction) {
  const details: Record<ManualStepAction, string> = {
    event: "MemoryEvent 已创建",
    data_lake: "解析片段已生成",
    timeline_fusion: "事实抽取和时间轴融合已完成",
    stm: "STM 已写入并建立可召回索引",
    ltm: "长期记忆已更新"
  };
  return details[action];
}
