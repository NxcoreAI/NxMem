import test from "node:test";
import assert from "node:assert/strict";
import {
  LOCOMO_LLM_JUDGE_VERSION,
  buildLocomoJudgePrompt,
  judgeLocomoAnswer,
  parseLocomoJudgeResponse,
  preprocessLocomoJudgeAnswer
} from "./locomo-llm-judge.js";

test("preprocessLocomoJudgeAnswer truncates category 3 gold answers at the first semicolon", () => {
  assert.equal(preprocessLocomoJudgeAnswer(3, "parrots; they are noisy"), "parrots");
  assert.equal(preprocessLocomoJudgeAnswer(1, "parrots; they are noisy"), "parrots; they are noisy");
  assert.equal(preprocessLocomoJudgeAnswer(4, "no semicolon"), "no semicolon");
});

test("buildLocomoJudgePrompt uses the unified locomo judge template", () => {
  const prompt = buildLocomoJudgePrompt({ category: 2, question: "Q?", answer: "gold", response: "guess" });
  assert.match(prompt, /^Label the generated answer as CORRECT or WRONG\./);
  assert.match(prompt, /PARTIAL CREDIT/);
  assert.match(prompt, /DATE TOLERANCE/);
  assert.match(prompt, /Question: Q\?/);
  assert.match(prompt, /Gold answer: gold/);
  assert.match(prompt, /Generated answer: guess/);
  assert.match(prompt, /Return JSON with "reasoning" \(one sentence\) and "label" \(CORRECT or WRONG\)/);
  // 统一模板：类别不改变 prompt
  assert.equal(prompt, buildLocomoJudgePrompt({ category: 4, question: "Q?", answer: "gold", response: "guess" }));
});

test("parseLocomoJudgeResponse accepts judge JSON variants and rejects the rest", () => {
  assert.deepEqual(parseLocomoJudgeResponse('{"reasoning":"same fact","label":"CORRECT"}'), { label: "CORRECT", reasoning: "same fact" });
  assert.deepEqual(parseLocomoJudgeResponse('{"label":"wrong","reasoning":"off topic"}'), { label: "WRONG", reasoning: "off topic" });
  assert.deepEqual(parseLocomoJudgeResponse('{"final":"{\\"reasoning\\":\\"wrapped\\",\\"label\\":\\"CORRECT\\"}"}'), { label: "CORRECT", reasoning: "wrapped" });
  assert.deepEqual(parseLocomoJudgeResponse('```json\n{"reasoning":"fenced","label":"CORRECT"}\n```'), { label: "CORRECT", reasoning: "fenced" });
  assert.equal(parseLocomoJudgeResponse("yes"), undefined);
  assert.equal(parseLocomoJudgeResponse('{"label":"MAYBE"}'), undefined);
  assert.equal(parseLocomoJudgeResponse("not json"), undefined);
});

test("judgeLocomoAnswer skips adversarial questions and missing judge models", async () => {
  assert.deepEqual(
    await judgeLocomoAnswer({ category: 5, question: "q", referenceAnswer: "a", response: "r" }),
    { status: "skipped", reason: "adversarial_category_not_judged", judgeVersion: LOCOMO_LLM_JUDGE_VERSION }
  );
  assert.deepEqual(
    await judgeLocomoAnswer({ category: 1, question: "q", referenceAnswer: "a", response: "r" }),
    { status: "skipped", reason: "judge_model_not_configured", judgeVersion: LOCOMO_LLM_JUDGE_VERSION }
  );
});

test("judgeLocomoAnswer judges via generateJudge and retries once on invalid JSON", async () => {
  let calls = 0;
  const judged = await judgeLocomoAnswer({
    category: 1,
    question: "q",
    referenceAnswer: "a",
    response: "r",
    generateJudge: async () => {
      calls += 1;
      return calls === 1 ? "not json" : '{"reasoning":"partial match","label":"CORRECT"}';
    }
  });
  if (judged.status !== "judged") throw new Error(`expected judged, got ${judged.status}`);
  assert.equal(judged.label, "CORRECT");
  assert.equal(judged.score, 1);
  assert.equal(judged.reasoning, "partial match");
  assert.equal(calls, 2);

  const failed = await judgeLocomoAnswer({
    category: 2,
    question: "q",
    referenceAnswer: "a",
    response: "r",
    generateJudge: async () => "still not json"
  });
  assert.deepEqual(failed, { status: "failed", reason: "invalid_judge_json", judgeVersion: LOCOMO_LLM_JUDGE_VERSION });
});

test("judgeLocomoAnswer sends the locomo judge system prompt and JSON mode via the model endpoint", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const outcome = await judgeLocomoAnswer({
    category: 3,
    question: "q?",
    referenceAnswer: "parrots; noisy",
    response: "parrots",
    model: {
      baseUrl: "http://judge.example.com/v1",
      model: "judge-model",
      apiKey: "test-key",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"reasoning":"matches","label":"CORRECT"}' } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }) as typeof fetch
    }
  });
  if (outcome.status !== "judged") throw new Error(`expected judged, got ${outcome.status}`);
  assert.equal(outcome.label, "CORRECT");
  assert.equal(outcome.model, "judge-model");
  const request = requests[0]!;
  assert.equal(request.url, "http://judge.example.com/v1/chat/completions");
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  const messages = request.body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]!.content, "You are evaluating conversational AI memory recall. Return JSON only with the format requested.");
  assert.match(messages[1]!.content, /Gold answer: parrots\n/); // 类别 3 分号截断生效
});
