import type { LocomoCategory } from "./locomo-dataset.js";
import type { LocomoAnswerModel } from "./locomo-evaluation.js";
import { postOpenAiCompatibleJson } from "./llm-request.js";

// locomo LLM judge（移植自 memory-benchmarks-main/benchmarks/locomo/prompts.py 的统一判分模板）。
// J-score 方法论：类别 1-4 用二元 LLM judge（CORRECT/WRONG）；类别 5（adversarial）不计入。
export const LOCOMO_LLM_JUDGE_VERSION = "locomo-llm-judge-v1";
export const LOCOMO_JUDGE_CATEGORIES = [1, 2, 3, 4] as const;

const LOCOMO_JUDGE_SYSTEM_PROMPT = "You are evaluating conversational AI memory recall. Return JSON only with the format requested.";

const LOCOMO_JUDGE_RULES = `Label the generated answer as CORRECT or WRONG.

## Rules

1. **PARTIAL CREDIT**: If the generated answer includes AT LEAST ONE correct item from the gold answer's list, mark CORRECT. Getting 1 out of 2, 2 out of 4, etc. is always acceptable. Only mark WRONG if NONE of the gold answer items appear.

2. **PARAPHRASES COUNT**: Same concept in different words is CORRECT. "Chocolate raspberry tart" = "chocolate cake with raspberries". "Shelter meal service" = "volunteering at a homeless shelter". Emotions and sentiments in the same positive/negative family count as paraphrases: "proud" = "fulfilled" = "accomplished"; "huge success" = "relieved" = "thrilled" (all express positive achievement). Judge semantic meaning, not exact wording.

3. **EXTRA DETAIL IS FINE**: A longer answer that includes the gold answer's key facts plus additional information is CORRECT. Never penalize for being more detailed or specific. If the generated answer adds extra descriptive details beyond the gold answer while still referencing the same core entity or concept, mark CORRECT.

4. **DATE TOLERANCE**: Dates within 14 days of each other are CORRECT. Durations within 50% are CORRECT (e.g., "5 months" matches "six months"; "19 days" matches "two weeks"). Relative dates ("few days before November") match specific dates in the same window. A specific date (e.g., "February 2020") that is consistent with a vague reference (e.g., "a few years ago" relative to 2023) is CORRECT. Converting "last year" to the actual year (e.g., "2022" when conversations are in 2023) is CORRECT.

5. **SEMANTIC OVERLAP**: Judge whether the generated answer addresses the same topic and captures the core idea of the gold answer. Different wording, phrasing, or level of detail should not result in WRONG if the underlying concept matches. For EMOTIONS and FEELINGS questions, answers expressing sentiments in the same valence (positive/negative) about the same event are CORRECT — do not require the exact same emotion word.

6. **SAME REFERENT**: If the generated answer mentions or references the same named entity, character, person, or concept as the gold answer, mark CORRECT — even if the generated answer provides a different physical description or includes additional details. The key question is: does the generated answer identify the same core entity? If yes, it is CORRECT.

7. **FOCUS ON KNOWLEDGE, NOT WORDING**: The goal is to assess whether the system recalled the right fact. Minor differences in specificity, phrasing, or scope should not result in WRONG. Only mark WRONG when the generated answer demonstrates a genuinely different or incorrect understanding.

## ONLY mark WRONG if:
- The generated answer contains ZERO correct items from the gold answer
- The answer addresses a completely different topic`;

export type LocomoJudgeOutcome =
  | { status: "judged"; label: "CORRECT" | "WRONG"; score: number; reasoning: string; model: string; judgeVersion: typeof LOCOMO_LLM_JUDGE_VERSION }
  | { status: "skipped"; reason: string; judgeVersion: typeof LOCOMO_LLM_JUDGE_VERSION }
  | { status: "failed"; reason: string; judgeVersion: typeof LOCOMO_LLM_JUDGE_VERSION };

export function preprocessLocomoJudgeAnswer(category: LocomoCategory, answer: string) {
  // 类别 3（open-domain）金答案取分号前的第一段，与 memory-benchmarks-main 的 preprocess_answer 一致
  return category === 3 && answer.includes(";") ? answer.split(";")[0]!.trim() : answer;
}

export function buildLocomoJudgePrompt(input: {
  category: LocomoCategory;
  question: string;
  answer: string;
  response: string;
}) {
  // 统一模板，所有类别同一份 prompt（与参考实现一致，category 仅保留签名兼容）
  return `${LOCOMO_JUDGE_RULES}

## Question
Question: ${input.question}
Gold answer: ${input.answer}
Generated answer: ${input.response}

Return JSON with "reasoning" (one sentence) and "label" (CORRECT or WRONG). Do NOT include both labels.`;
}

export function parseLocomoJudgeResponse(text: string): { label: "CORRECT" | "WRONG"; reasoning: string } | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let record = readJsonObject(text.slice(start, end + 1));
  if (!record) return undefined;
  if ("final" in record && Object.keys(record).length === 1) {
    const inner = record.final;
    const unwrapped = typeof inner === "string"
      ? readJsonObject(inner.trim())
      : inner && typeof inner === "object" && !Array.isArray(inner)
        ? (inner as Record<string, unknown>)
        : undefined;
    if (!unwrapped) return undefined;
    record = unwrapped;
  }
  const label = typeof record.label === "string" ? record.label.trim().toUpperCase() : "";
  if (label !== "CORRECT" && label !== "WRONG") return undefined;
  return { label, reasoning: typeof record.reasoning === "string" ? record.reasoning.trim() : "" };
}

export async function judgeLocomoAnswer(input: {
  category: LocomoCategory;
  question: string;
  referenceAnswer: string;
  response: string;
  model?: LocomoAnswerModel;
  generateJudge?: (prompt: string) => Promise<string>;
}): Promise<LocomoJudgeOutcome> {
  if (input.category === 5) {
    return { status: "skipped", reason: "adversarial_category_not_judged", judgeVersion: LOCOMO_LLM_JUDGE_VERSION };
  }
  if (!input.generateJudge && !input.model) {
    return { status: "skipped", reason: "judge_model_not_configured", judgeVersion: LOCOMO_LLM_JUDGE_VERSION };
  }
  const prompt = buildLocomoJudgePrompt({
    category: input.category,
    question: input.question,
    answer: preprocessLocomoJudgeAnswer(input.category, input.referenceAnswer),
    response: input.response
  });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let text: string;
    try {
      text = input.generateJudge ? await input.generateJudge(prompt) : await requestLocomoJudge(prompt, input.model!);
    } catch (error) {
      if (attempt === 2) {
        return { status: "failed", reason: error instanceof Error ? error.message : String(error), judgeVersion: LOCOMO_LLM_JUDGE_VERSION };
      }
      continue;
    }
    const parsed = parseLocomoJudgeResponse(text);
    if (parsed) {
      return {
        status: "judged",
        label: parsed.label,
        score: parsed.label === "CORRECT" ? 1 : 0,
        reasoning: parsed.reasoning,
        model: input.model?.model ?? "injected",
        judgeVersion: LOCOMO_LLM_JUDGE_VERSION
      };
    }
  }
  return { status: "failed", reason: "invalid_judge_json", judgeVersion: LOCOMO_LLM_JUDGE_VERSION };
}

async function requestLocomoJudge(prompt: string, model: LocomoAnswerModel) {
  const payload = await postOpenAiCompatibleJson({
    endpoint: `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    apiKey: model.apiKey ?? "",
    operation: "locomo_judge",
    body: {
      model: model.model,
      messages: [
        { role: "system", content: LOCOMO_JUDGE_SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    },
    ...(model.fetchImpl ? { fetchImpl: model.fetchImpl } : {})
  }) as { choices?: Array<{ message?: { content?: string } }> };
  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LoCoMo judge model returned an empty response");
  return text;
}

function readJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
