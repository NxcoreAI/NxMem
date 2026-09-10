import type { FactItem } from "./domain.js";

const NUMBER = String.raw`(?:\d+(?:[.:]\d+)?(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|hundred|thousand|million|billion)`;
const UNIT = String.raw`(?:%|％|percent(?:age)?|usd|eur|gbp|cny|rmb|dollars?|euros?|pounds?|yuan|seconds?|minutes?|hours?|days?|weeks?|months?|years?|pairs?|items?|pieces?|shoes?|people|users?|cars?|miles?|kilometers?|kilometres?|meters?|metres?|kilograms?|kgs?|grams?|ounces?|oz|lbs?)`;
const QUANTITY_MODIFIER = String.raw`(?:(?:additional|extra|more|fewer|less)\s+)?`;
const QUANTIFIED_VALUE = new RegExp(String.raw`(?:[$€£¥￥]\s*${NUMBER}\b|\b${NUMBER}\s*${QUANTITY_MODIFIER}${UNIT}\b)`, "iu");
const DATE_VALUE = new RegExp(
  String.raw`(?:\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}:\d{2}\b)`,
  "iu"
);
const CHINESE_QUANTIFIED_VALUE = /(?:[$€£¥￥]\s*\d)|(?:[零一二两三四五六七八九十百千万亿\d]+(?:\.\d+)?\s*(?:%|％|美元|欧元|英镑|人民币|元|秒|分钟|小时|天|周|星期|月|年|双|对|件|个|次|公里|千米|米|公斤|千克|克|磅))/u;
const NON_ASSERTIVE = /(?:\b(?:suppose|hypothetical(?:ly)?|for example|e\.g\.)\b|假设|例如|举例)/iu;

export function isMeaningfulQuantitativeFact(fact: FactItem) {
  if (fact.confidenceLevel === "low") return false;
  const text = `${fact.factText}\n${fact.normalizedClaim}`.normalize("NFKC").trim();
  if (!text || NON_ASSERTIVE.test(text) || isPureQuestion(text)) return false;
  return QUANTIFIED_VALUE.test(text) || DATE_VALUE.test(text) || CHINESE_QUANTIFIED_VALUE.test(text);
}

function isPureQuestion(text: string) {
  const trimmed = text.trim();
  return /[?？]$/u.test(trimmed) && /^(?:what|when|where|who|why|how|is|are|do|does|did|can|could|would|should|多少|几|何时|什么时候|是否|能否)/iu.test(trimmed);
}
