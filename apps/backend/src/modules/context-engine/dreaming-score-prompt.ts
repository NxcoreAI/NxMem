import type { DreamingScoreFactors } from "./domain.js";

export const DREAMING_SCORING_PROMPT_VERSION = "ltm-dreaming-stm-score.v2";
export const DREAMING_SCORING_RUBRIC_VERSION = "stm-ltm-seven-factor-rubric.v1";
export const DREAMING_SCORING_REFERENCE_DOCUMENT = "STM到LTM七维评分Prompt.md";

export interface DreamingScoringCandidate {
  memoryDataId: string;
  memoryDataType: string;
  memoryType?: string;
  content: string;
  summary?: string;
  importanceLevel: string;
  confidenceLevel: string;
  lifecycleStatus: string;
  matchedRules: string[];
  sourceFactIds: string[];
  entityIds: string[];
  admissionResult: string;
  admissionReason: string;
  evidenceTimeStart?: string;
  evidenceTimeEnd?: string;
  validTimeStart?: string;
  validTimeEnd?: string;
}

const reasonFormat = "evidence=<引用候选字段或 none>; rationale=<根据本维度锚点说明为何是该分数>";

export function buildDreamingScoringPrompt(candidates: readonly DreamingScoringCandidate[]) {
  return JSON.stringify({
    instruction: "你是 Context 引擎的 STM 长期价值评分器。只返回严格 JSON，不要输出推理过程、Markdown 或代码块。",
    task: "使用下列统一标准分别评估每条 STM。不得合并 STM，不得创作、改写、摘要或生成长期记忆内容。",
    rubricVersion: DREAMING_SCORING_RUBRIC_VERSION,
    referenceDocument: DREAMING_SCORING_REFERENCE_DOCUMENT,
    scoringProtocol: [
      "只使用当前候选自身字段作证据；不得使用其他候选、外部知识或臆测补证。",
      "先为每个维度找到最接近的锚点，再输出 0 到 10 的整数；证据不足时保守评分。",
      "七个维度独立评分，不得因某一维很高而整体抬高其他维度。",
      "importanceLevel、confidenceLevel 和 matchedRules 只能作为明示辅助证据，不能替代 content 中的语义证据。",
      "每个 scoreReason 必须使用指定格式，并指明证据来自哪个候选字段。",
      "reuseValue 由服务端根据历史召回计算；模型必须固定返回 0，不得推测历史复用。",
      "不要计算 consolidate、observe 或 drop；最终加权和决策由服务端完成。"
    ],
    commonScale: {
      "0": "明确无该维度价值，或有反向证据",
      "1-2": "仅有很弱、偶然或短暂证据",
      "3-4": "有部分证据，但含义较弱、不完整或明显短期",
      "5": "中性、不适用或证据不足；不是默认高分",
      "6-7": "有明确且较强证据，但持久性、完整性或影响范围有限",
      "8-9": "有强、直接、持久且可操作的证据",
      "10": "极端且罕见；必须有明确的长期或不可逆表达，不得仅因“很重要”给满分"
    },
    dimensions: {
      stability: {
        question: "这条主张在未来保持真实或有效的可能性有多高？",
        anchors: {
          "0": "已失效、已被否定或纯对话状态",
          "2": "小时到数天的短暂事实或一次性状态",
          "4": "短期项目状态、临时选择，或有明确 validTimeEnd",
          "5": "无法从候选判断持续时间",
          "6": "预计持续数月的明确决定、规则或状态",
          "8": "明确表达为跨场景、长期有效的偏好、关系或工作方式",
          "10": "明确永久或本质上稳定的身份/制度事实，且无反向证据"
        }
      },
      reuseValue: {
        question: "该 STM 过去是否被真实召回、引用或复用？",
        anchors: { "0": "固定占位值；服务端将用历史事件覆盖它" }
      },
      identityRelationValue: {
        question: "该 STM 对用户身份、持续角色或稳定关系的描述价值有多高？",
        anchors: {
          "0": "不涉及身份、角色或关系",
          "2": "仅偶然提及人名或组织",
          "4": "临时项目角色或短期协作关系",
          "5": "可能有关，但持续性或关系类型不清楚",
          "6": "明确的持续责任、团队归属或重要关系",
          "8": "明确且稳定的职业身份、核心角色或长期人际关系",
          "10": "核心法定/组织身份或对多场景决策关键的持久关系"
        }
      },
      actionCommitmentValue: {
        question: "该 STM 包含的行动、承诺或未来义务有多具体、确定且可执行？",
        anchors: {
          "0": "没有行动或承诺",
          "2": "推测、建议、可能性或无主体想法",
          "4": "有意向，但没有明确责任人、交付物或时间",
          "5": "行动可理解，但关键执行条件不完整",
          "6": "已确认的具体行动或项目决定",
          "8": "明确责任人、交付物、截止时间或依赖中的多项",
          "10": "高后果、不可逆或受契约约束的明确承诺"
        }
      },
      informationEntropy: {
        question: "该 STM 自身包含多少可区分、具体且非套话的信息？",
        anchors: {
          "0": "空内容、寒暄、纯情绪词或无主张重复",
          "2": "泛化表述，几乎没有对象、属性或约束",
          "4": "包含一个清晰事实或属性",
          "5": "有意义但常见，区分度中等",
          "6": "包含多个彼此绑定的对象、时间、状态或约束",
          "8": "高度具体，能显著区分用户、项目或工作方式",
          "10": "罕见且高密度的关键决策/配置；不得仅因文本很长给满分"
        }
      },
      explicitWeight: {
        question: "用户或 Agent 是否明确要求记住、强调或确认了该信息的重要性？",
        anchors: {
          "0": "没有任何强调或记忆意图",
          "2": "只是在上下文中顺带提及",
          "4": "表述清楚，但没有额外强调",
          "5": "重要性不可判定",
          "6": "明确确认为重要决定、约束或规则",
          "8": "直接出现“请记住”“以后始终”或等价的持久记忆指令",
          "10": "明确持久、不得遗忘且遗忘后果重大的指令"
        }
      },
      preferenceConsistency: {
        question: "该 STM 是否明确、自洽地表达了可跨场景复用的偏好？",
        anchors: {
          "0": "已明确否定该偏好，或同一 STM 内自相矛盾",
          "2": "一次性选择、临时口味或他人的偏好",
          "4": "弱偏好或仅对当前任务有效",
          "5": "该 STM 不是偏好，或无法判定；非偏好记忆必须使用此中性分",
          "6": "明确表达用户的偏好，但跨场景持续性不完整",
          "8": "明确用“以后”“通常”等表达持续且自洽的偏好",
          "10": "用“始终”“绝不”等明确跨场景、无条件表达的稳定偏好"
        }
      }
    },
    hardCaps: [
      "出现“可能”“也许”“考虑”等未承诺表达时，actionCommitmentValue 不得高于 4。",
      "有明确 validTimeEnd 且不是周期性规则时，stability 不得高于 4。",
      "只是助手建议、用户未确认时，actionCommitmentValue、explicitWeight 和 preferenceConsistency 不得高于 2。",
      "没有明确身份、角色或关系主张时，identityRelationValue 不得高于 2。",
      "非偏好类主张的 preferenceConsistency 必须为 5，不得用该维度奖励或惩罚事实、项目或任务记忆。",
      "没有系统历史复用事件输入，reuseValue 必须为 0。"
    ],
    calibrationExamples: [
      {
        input: "用户今天下午喝了一杯咖啡。",
        scores: { stability: 2, reuseValue: 0, identityRelationValue: 0, actionCommitmentValue: 0, informationEntropy: 4, explicitWeight: 0, preferenceConsistency: 5 }
      },
      {
        input: "用户要求：以后所有技术回答都先给结论，再补充依据。",
        scores: { stability: 9, reuseValue: 0, identityRelationValue: 2, actionCommitmentValue: 6, informationEntropy: 6, explicitWeight: 9, preferenceConsistency: 10 }
      },
      {
        input: "Orion 项目已确认使用 Neo4j，张三负责迁移，9 月 30 日前上线。",
        scores: { stability: 7, reuseValue: 0, identityRelationValue: 6, actionCommitmentValue: 9, informationEntropy: 8, explicitWeight: 6, preferenceConsistency: 5 }
      },
      {
        input: "助手建议用户也许可以考虑明天跑步，用户未回应。",
        scores: { stability: 2, reuseValue: 0, identityRelationValue: 0, actionCommitmentValue: 2, informationEntropy: 3, explicitWeight: 0, preferenceConsistency: 2 }
      }
    ],
    outputSchema: {
      scores: [{
        memoryDataId: "stm_id",
        scores: {
          stability: "0..10 integer",
          reuseValue: "must be 0",
          identityRelationValue: "0..10 integer",
          actionCommitmentValue: "0..10 integer",
          informationEntropy: "0..10 integer",
          explicitWeight: "0..10 integer",
          preferenceConsistency: "0..10 integer"
        } satisfies Record<keyof DreamingScoreFactors, string>,
        scoreReasons: {
          stability: reasonFormat,
          reuseValue: "evidence=server_owned; rationale=placeholder_only",
          identityRelationValue: reasonFormat,
          actionCommitmentValue: reasonFormat,
          informationEntropy: reasonFormat,
          explicitWeight: reasonFormat,
          preferenceConsistency: reasonFormat
        } satisfies Record<keyof DreamingScoreFactors, string>
      }]
    },
    outputConstraints: [
      "scores 必须为每条 candidates 输入恰好返回一项，并使用原 memoryDataId。",
      "每项必须包含完整七维整数分数和完整七维 scoreReasons。",
      `scoreReasons 必须严格使用格式：${reasonFormat}。`,
      "不得返回 content、summary、memoryType、theoryClass、sourceMemoryDataIds、长期记忆或关系边。",
      "不得返回 consolidate、observe 或 drop 决策。"
    ],
    candidates
  }, null, 2);
}
