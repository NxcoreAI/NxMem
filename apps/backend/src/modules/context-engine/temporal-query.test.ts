import test from "node:test";
import assert from "node:assert/strict";
import {
  inferTemporalSearchBasis,
  resolveTemporalQuery,
  TemporalQueryError
} from "./temporal-query.js";

const referenceTime = "2026-07-25T04:30:00.000Z";

test("explicit temporal range wins over natural-language expressions and is normalized", async () => {
  let semanticCalls = 0;
  const resolved = await resolveTemporalQuery({
    text: "昨天聊过什么",
    referenceTime,
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    timeRange: {
      startTime: "2026-07-01T08:00:00+08:00",
      endTime: "2026-07-02T08:00:00+08:00",
      basis: "valid"
    }
  }, {
    semanticResolver: {
      resolve() {
        semanticCalls += 1;
        return undefined;
      }
    }
  });

  assert.deepEqual(resolved.range, {
    startTime: "2026-07-01T00:00:00.000Z",
    endTime: "2026-07-02T00:00:00.000Z"
  });
  assert.equal(resolved.basis, "valid");
  assert.equal(resolved.source, "explicit");
  assert.equal(semanticCalls, 0);
});

test("resolver maps local natural days, weeks and recent N days to half-open UTC ranges", async () => {
  const yesterday = await resolveTemporalQuery({
    text: "昨天聊了什么",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.deepEqual(yesterday.range, {
    startTime: "2026-07-23T16:00:00.000Z",
    endTime: "2026-07-24T16:00:00.000Z"
  });
  assert.equal(yesterday.basis, "evidence");

  const dayBeforeYesterday = await resolveTemporalQuery({
    text: "前天的消息",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.equal(dayBeforeYesterday.range?.startTime, "2026-07-22T16:00:00.000Z");

  const thisWeek = await resolveTemporalQuery({
    text: "本周发生的事情",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.deepEqual(thisWeek.range, {
    startTime: "2026-07-19T16:00:00.000Z",
    endTime: "2026-07-26T16:00:00.000Z"
  });
  assert.equal(thisWeek.basis, "valid");

  const lastWeek = await resolveTemporalQuery({
    text: "上周说过什么",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.deepEqual(lastWeek.range, {
    startTime: "2026-07-12T16:00:00.000Z",
    endTime: "2026-07-19T16:00:00.000Z"
  });

  const recentThreeDays = await resolveTemporalQuery({
    text: "最近三天的对话",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.deepEqual(recentThreeDays.range, {
    startTime: "2026-07-22T16:00:00.000Z",
    endTime: "2026-07-25T16:00:00.000Z"
  });
});

test("resolver distinguishes relative ranges from calendar-aware offset points", async () => {
  const pastTwoWeeks = await resolveTemporalQuery({
    text: "过去两周聊了什么",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.deepEqual(pastTwoWeeks.range, {
    startTime: "2026-07-11T16:00:00.000Z",
    endTime: "2026-07-25T16:00:00.000Z"
  });

  const nextFiveDays = await resolveTemporalQuery({
    text: "接下来五天有什么计划",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.deepEqual(nextFiveDays.range, {
    startTime: "2026-07-24T16:00:00.000Z",
    endTime: "2026-07-29T16:00:00.000Z"
  });

  const oneYearAgo = await resolveTemporalQuery({
    text: "一年前发生了什么",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.deepEqual(oneYearAgo.range, {
    startTime: "2025-07-24T16:00:00.000Z",
    endTime: "2025-07-25T16:00:00.000Z"
  });

  const threeMonthsAgo = await resolveTemporalQuery({
    text: "three months ago",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.deepEqual(threeMonthsAgo.range, {
    startTime: "2026-03-31T16:00:00.000Z",
    endTime: "2026-04-30T16:00:00.000Z"
  });

  const twoWeeksLater = await resolveTemporalQuery({
    text: "两周后出发",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.equal(twoWeeksLater.range?.startTime, "2026-08-07T16:00:00.000Z");
});

test("resolver supports minute and hour offsets in Chinese and English", async () => {
  const afterTwoHours = await resolveTemporalQuery({
    text: "after 2 hours the job will finish",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.deepEqual(afterTwoHours.range, {
    startTime: "2026-07-25T06:30:00.000Z",
    endTime: "2026-07-25T07:30:00.000Z"
  });

  const thirtyMinutesAgo = await resolveTemporalQuery({
    text: "三十分钟前发生的事情",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.deepEqual(thirtyMinutesAgo.range, {
    startTime: "2026-07-25T04:00:00.000Z",
    endTime: "2026-07-25T04:01:00.000Z"
  });
});

test("resolver supports complete previous and next calendar periods", async () => {
  const lastMonth = await resolveTemporalQuery({
    text: "last month messages",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.deepEqual(lastMonth.range, {
    startTime: "2026-05-31T16:00:00.000Z",
    endTime: "2026-06-30T16:00:00.000Z"
  });

  const nextYear = await resolveTemporalQuery({
    text: "明年的计划",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.deepEqual(nextYear.range, {
    startTime: "2026-12-31T16:00:00.000Z",
    endTime: "2027-12-31T16:00:00.000Z"
  });
});

test("resolver does not guess ambiguous offsets or mistake durations for occurrence time", async () => {
  const ambiguous = await resolveTemporalQuery({
    text: "几小时后提醒我",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.equal(ambiguous.range, undefined);
  assert.equal(ambiguous.source, "none");

  const duration = await resolveTemporalQuery({
    text: "项目持续两周",
    referenceTime,
    timezone: "Asia/Shanghai"
  });
  assert.equal(duration.range, undefined);
  assert.equal(duration.source, "none");
});

test("resolver recognizes explicit local dates and timezone priority", async () => {
  const resolved = await resolveTemporalQuery({
    text: "2026年8月1日计划去深圳",
    referenceTime
  }, {
    principalTimezone: "America/New_York",
    tenantTimezone: "Europe/Berlin"
  });

  assert.equal(resolved.timezone, "America/New_York");
  assert.deepEqual(resolved.range, {
    startTime: "2026-08-01T04:00:00.000Z",
    endTime: "2026-08-02T04:00:00.000Z"
  });
  assert.equal(resolved.basis, "valid");

  const requestOverride = await resolveTemporalQuery({
    text: "8月1日的消息",
    referenceTime,
    timezone: "Asia/Tokyo"
  }, {
    principalTimezone: "America/New_York"
  });
  assert.equal(requestOverride.timezone, "Asia/Tokyo");
  assert.equal(requestOverride.range?.startTime, "2026-07-31T15:00:00.000Z");
});

test("local-day conversion preserves 23-hour and 25-hour DST days", async () => {
  const springForward = await resolveTemporalQuery({
    text: "2026-03-08 发生的事情",
    referenceTime: "2026-03-08T16:00:00.000Z",
    timezone: "America/New_York"
  });
  assert.deepEqual(springForward.range, {
    startTime: "2026-03-08T05:00:00.000Z",
    endTime: "2026-03-09T04:00:00.000Z"
  });
  assert.equal(rangeDurationMs(springForward.range!), 23 * 60 * 60 * 1000);

  const fallBack = await resolveTemporalQuery({
    text: "2026-11-01 发生的事情",
    referenceTime: "2026-11-01T16:00:00.000Z",
    timezone: "America/New_York"
  });
  assert.deepEqual(fallBack.range, {
    startTime: "2026-11-01T04:00:00.000Z",
    endTime: "2026-11-02T05:00:00.000Z"
  });
  assert.equal(rangeDurationMs(fallBack.range!), 25 * 60 * 60 * 1000);
});

function rangeDurationMs(range: { startTime: string; endTime: string }) {
  return Date.parse(range.endTime) - Date.parse(range.startTime);
}

test("semantic resolver is pluggable and failure never invents a range", async () => {
  const semantic = await resolveTemporalQuery({
    text: "月底前生效的规则",
    referenceTime,
    timezone: "Asia/Shanghai"
  }, {
    semanticResolver: {
      resolve(input) {
        assert.equal(input.basis, "valid");
        return {
          range: {
            startTime: "2026-07-25T00:00:00.000Z",
            endTime: "2026-08-01T00:00:00.000Z"
          },
          confidence: "medium"
        };
      }
    }
  });
  assert.equal(semantic.source, "semantic");
  assert.equal(semantic.basis, "valid");

  const failed = await resolveTemporalQuery({
    text: "之前那次说过什么",
    referenceTime,
    timezone: "Asia/Shanghai"
  }, {
    semanticResolver: {
      resolve() {
        throw new Error("semantic service unavailable");
      }
    }
  });
  assert.equal(failed.range, undefined);
  assert.equal(failed.source, "none");
  assert.equal(failed.confidence, "low");
  assert.equal(failed.resolutionError, "semantic_resolver_failed");
});

test("basis inference distinguishes evidence, valid and ambiguous intent", () => {
  assert.equal(inferTemporalSearchBasis("昨天聊过什么"), "evidence");
  assert.equal(inferTemporalSearchBasis("计划什么时候生效"), "valid");
  assert.equal(inferTemporalSearchBasis("昨天说过计划什么时候生效"), "auto");
  assert.equal(inferTemporalSearchBasis("深圳行程"), "auto");
});

test("invalid explicit range, reference time, timezone and locale are rejected", async () => {
  await assert.rejects(
    resolveTemporalQuery({
      text: "test",
      timeRange: {
        startTime: "2026-07-02T00:00:00.000Z",
        endTime: "2026-07-01T00:00:00.000Z"
      }
    }),
    (error) => error instanceof TemporalQueryError && error.code === "TEMPORAL_RANGE_INVALID"
  );
  await assert.rejects(
    resolveTemporalQuery({ text: "test", referenceTime: "2026-07-25" }),
    (error) => error instanceof TemporalQueryError && error.code === "TEMPORAL_REFERENCE_TIME_INVALID"
  );
  await assert.rejects(
    resolveTemporalQuery({ text: "test", timezone: "Mars/Olympus" }),
    (error) => error instanceof TemporalQueryError && error.code === "TEMPORAL_TIMEZONE_INVALID"
  );
  await assert.rejects(
    resolveTemporalQuery({ text: "test", locale: "not_a_locale" }),
    (error) => error instanceof TemporalQueryError && error.code === "TEMPORAL_LOCALE_INVALID"
  );
});
