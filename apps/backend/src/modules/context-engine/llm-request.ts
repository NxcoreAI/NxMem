import OpenAI from "openai";

export interface OpenAiCompatibleRequestLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface OpenAiCompatibleRequestObservation {
  status: "started" | "succeeded" | "failed";
  operation: string;
  endpoint: string;
  startedAt: string;
  elapsedMs?: number;
  error?: string;
  /** The actual transport attempt within the existing request retry loop. */
  internalAttempt?: number;
  model?: string;
  requestBody?: unknown;
  response?: unknown;
  usage?: unknown;
  structuredError?: {
    name: string;
    message: string;
    code?: string | number;
    status?: number;
  };
  context?: Record<string, unknown>;
}

export type OpenAiCompatibleRequestObserver = (observation: OpenAiCompatibleRequestObservation) => void;

export interface OpenAiCompatibleRequestOptions {
  endpoint: string;
  apiKey?: string;
  body: unknown;
  operation: string;
  timeoutMs?: number;
  /** Total attempts, including the first request. */
  maxAttempts?: number;
  /** Delay between transient failures. Defaults to 10 seconds. */
  retryDelayMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  logger?: OpenAiCompatibleRequestLogger;
  logContext?: Record<string, unknown>;
  transport?: "fetch" | "openai-sdk-stream";
  observer?: OpenAiCompatibleRequestObserver;
}

export const DEFAULT_LLM_REQUEST_MAX_ATTEMPTS = 10;
export const DEFAULT_LLM_REQUEST_RETRY_DELAY_MS = 10_000;
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 5_000;
const RATE_LIMIT_RETRY_DELAY_MAX_MS = 120_000;

export class LlmRequestRetryExhaustedError extends Error {
  readonly operation: string;
  readonly attempts: number;
  readonly lastError: string;

  constructor(operation: string, attempts: number, lastError: string) {
    super(`${operation} retry attempts exhausted after ${attempts} attempts: ${lastError}`);
    this.name = "LlmRequestRetryExhaustedError";
    this.operation = operation;
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export function isLlmRequestRetryExhausted(error: unknown): error is LlmRequestRetryExhaustedError {
  return error instanceof LlmRequestRetryExhaustedError;
}

export async function postOpenAiCompatibleJson(input: OpenAiCompatibleRequestOptions): Promise<unknown> {
  throwIfSignalAborted(input.signal, input.operation);
  return await retryLlmRequest(input, async (internalAttempt) => {
    if (input.transport === "openai-sdk-stream") {
      return await postOpenAiCompatibleStreamedJsonOnce(input, internalAttempt);
    }

    const response = await postOpenAiCompatibleResponseOnce(input, internalAttempt);
    const text = await response.text();
    if (!response.ok) {
      throw openAiCompatibleHttpError(response.status, text);
    }

    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  });
}

async function postOpenAiCompatibleStreamedJsonOnce(
  input: OpenAiCompatibleRequestOptions,
  internalAttempt: number
): Promise<unknown> {
  const endpoint = normalizeEndpoint(input.endpoint);
  const requestBody = prepareRequestBody(endpoint.resource, input.body);
  const observed = startObservation(input, internalAttempt, requestBody);
  const timeoutMs = input.timeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  let externallyAborted = input.signal?.aborted === true;
  const externalAbortHandler = () => {
    externallyAborted = true;
    controller.abort(input.signal?.reason);
  };
  input.signal?.addEventListener("abort", externalAbortHandler, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const client = new OpenAI({
    apiKey: input.apiKey ?? "",
    baseURL: endpoint.baseUrl,
    maxRetries: 0,
    timeout: timeoutMs,
    fetch: createStreamingFetch(input.fetchImpl ?? fetch) as typeof fetch
  });

  try {
    const result = endpoint.resource === "responses"
      ? await streamResponsesJson(client, requestBody, controller.signal)
      : endpoint.resource === "chat/completions"
        ? await streamChatCompletionJson(client, requestBody, controller.signal)
        : undefined;
    if (result === undefined) throw new Error(`unsupported_streaming_endpoint:${input.endpoint}`);
    finishObservation(input, observed, result);
    return result;
  } catch (error) {
    const normalizedError = externallyAborted
      ? abortError(input.operation)
      : timedOut || isAbortError(error)
        ? new Error(`${input.operation} timed out after ${timeoutMs}ms`)
        : error;
    if (!externallyAborted && (timedOut || isAbortError(error))) {
      logTimeout(input, timeoutMs, Date.now() - startedAt);
    }
    failObservation(input, observed, normalizedError);
    throw normalizedError;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", externalAbortHandler);
  }
}

async function streamResponsesJson(client: OpenAI, body: unknown, signal?: AbortSignal) {
  const stream = await client.responses.create({
    ...(isRecord(body) ? body : {}),
    stream: true
  } as Parameters<OpenAI["responses"]["create"]>[0] & { stream: true }, signal ? { signal } : undefined);
  let text = "";
  let finalResponse: unknown;

  for await (const event of stream as AsyncIterable<unknown>) {
    if (!isRecord(event)) continue;
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
    } else if (event.type === "response.completed" && "response" in event) {
      finalResponse = event.response;
    } else if (typeof event.output_text === "string" || Array.isArray(event.output)) {
      finalResponse = event;
    } else if (event.type === "response.failed" || event.type === "response.incomplete") {
      throw new Error(readResponseStreamFailure(event));
    }
  }

  if (finalResponse) return finalResponse;
  return {
    output_text: text,
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text }]
      }
    ]
  };
}

async function streamChatCompletionJson(client: OpenAI, body: unknown, signal?: AbortSignal) {
  const stream = await client.chat.completions.create({
    ...(isRecord(body) ? body : {}),
    stream: true
  } as Parameters<OpenAI["chat"]["completions"]["create"]>[0] & { stream: true }, signal ? { signal } : undefined);
  let text = "";
  let finalCompletion: unknown;

  for await (const chunk of stream as AsyncIterable<unknown>) {
    if (!isRecord(chunk)) continue;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const first = choices[0];
    if (isRecord(first)) {
      const delta = isRecord(first.delta) ? first.delta : undefined;
      if (typeof delta?.content === "string") text += delta.content;
      const message = isRecord(first.message) ? first.message : undefined;
      if (typeof message?.content === "string") finalCompletion = chunk;
    }
  }

  if (finalCompletion) return finalCompletion;
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: text
        }
      }
    ]
  };
}

function createStreamingFetch(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetchImpl(input, init);
    if (!isStreamingRequest(init) || isEventStreamResponse(response)) return response;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return response;

    const text = await response.text();
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${text}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    }), {
      status: response.status,
      statusText: response.statusText,
      headers: { "content-type": "text/event-stream" }
    });
  }) as typeof fetch;
}

function isStreamingRequest(init?: RequestInit) {
  if (!init?.body) return false;
  try {
    const body = JSON.parse(String(init.body)) as { stream?: unknown };
    return body.stream === true;
  } catch {
    return false;
  }
}

function isEventStreamResponse(response: Response) {
  return (response.headers.get("content-type") ?? "").includes("text/event-stream");
}

function normalizeEndpoint(endpoint: string) {
  const normalized = endpoint.replace(/\/+$/, "");
  for (const resource of ["chat/completions", "responses"] as const) {
    const suffix = `/${resource}`;
    if (normalized.endsWith(suffix)) {
      return {
        baseUrl: normalized.slice(0, -suffix.length),
        resource
      };
    }
  }
  return { baseUrl: normalized, resource: "" };
}

function prepareRequestBody(resource: string, body: unknown) {
  if (resource !== "chat/completions" || !isRecord(body)) return body;
  const { enable_thinking: _legacyEnableThinking, ...requestBody } = body;
  return {
    ...requestBody,
    thinking: { type: "disabled" }
  };
}

function readResponseStreamFailure(event: Record<string, unknown>) {
  const response = isRecord(event.response) ? event.response : event;
  const error = isRecord(response.error) ? response.error : undefined;
  if (typeof error?.message === "string") return error.message;
  if (typeof response.status === "string") return response.status;
  return "response_stream_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function postOpenAiCompatibleResponse(input: OpenAiCompatibleRequestOptions): Promise<Response> {
  return await retryLlmRequest(input, (internalAttempt) => postOpenAiCompatibleResponseOnce(input, internalAttempt));
}

async function postOpenAiCompatibleResponseOnce(
  input: OpenAiCompatibleRequestOptions,
  internalAttempt: number
): Promise<Response> {
  throwIfSignalAborted(input.signal, input.operation);
  const endpoint = normalizeEndpoint(input.endpoint);
  const requestBody = prepareRequestBody(endpoint.resource, input.body);
  const timeoutMs = input.timeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const startedAt = Date.now();
  const observed = startObservation(input, internalAttempt, requestBody);
  let timedOut = false;
  let externallyAborted = input.signal?.aborted === true;
  const externalAbortHandler = () => {
    externallyAborted = true;
    controller.abort(input.signal?.reason);
  };
  input.signal?.addEventListener("abort", externalAbortHandler, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(input.endpoint, {
      method: "POST",
      headers: {
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
        "content-type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    if (!response.ok && isTransientHttpStatus(response.status)) {
      throw new TransientLlmHttpError(response.status, truncate(await response.text(), 240), readRetryAfterMs(response.headers.get("retry-after")));
    }
    const rawResponse = await readObservationResponse(response.clone());
    finishObservation(input, observed, rawResponse);
    return response;
  } catch (error) {
    if (externallyAborted) {
      const cancelledError = abortError(input.operation);
      failObservation(input, observed, cancelledError);
      throw cancelledError;
    }
    if (timedOut || isAbortError(error)) {
      logTimeout(input, timeoutMs, Date.now() - startedAt);
      const timeoutError = new Error(`${input.operation} timed out after ${timeoutMs}ms`);
      failObservation(input, observed, timeoutError);
      throw timeoutError;
    }
    failObservation(input, observed, error);
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", externalAbortHandler);
  }
}

class TransientLlmHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number | undefined;

  constructor(status: number, body: string, retryAfterMs?: number) {
    super(`http_${status}:${body}`);
    this.name = "TransientLlmHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isRateLimitLlmError(error: unknown): boolean {
  if (error instanceof TransientLlmHttpError) return error.status === 429;
  return readNumericErrorProperty(error, "status") === 429 || readNumericErrorProperty(error, "statusCode") === 429;
}

export function rateLimitRetryDelayMs(attempt: number, error: unknown, baseDelayMs = DEFAULT_RATE_LIMIT_RETRY_DELAY_MS): number {
  if (!isRateLimitLlmError(error)) return 0;
  const retryAfter = error instanceof TransientLlmHttpError ? error.retryAfterMs : undefined;
  if (retryAfter !== undefined && retryAfter > 0) return Math.min(retryAfter, RATE_LIMIT_RETRY_DELAY_MAX_MS);
  const exponential = Math.max(baseDelayMs, 1) * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, RATE_LIMIT_RETRY_DELAY_MAX_MS);
}

async function retryLlmRequest<T>(
  input: OpenAiCompatibleRequestOptions,
  attempt: (internalAttempt: number) => Promise<T>
): Promise<T> {
  const maxAttempts = Math.min(
    normalizePositiveInteger(input.maxAttempts, DEFAULT_LLM_REQUEST_MAX_ATTEMPTS),
    DEFAULT_LLM_REQUEST_MAX_ATTEMPTS
  );
  const retryDelayMs = normalizeNonNegativeInteger(input.retryDelayMs, DEFAULT_LLM_REQUEST_RETRY_DELAY_MS);
  let lastError: unknown;
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    throwIfSignalAborted(input.signal, input.operation);
    try {
      return await attempt(attemptNumber);
    } catch (error) {
      lastError = error;
      if (input.signal?.aborted) throw error;
      if (!isRetryableLlmError(error)) throw error;
      if (attemptNumber >= maxAttempts) break;
      const rateLimitDelay = rateLimitRetryDelayMs(attemptNumber, error, retryDelayMs);
      const delay = rateLimitDelay > 0 ? rateLimitDelay : retryDelayMs;
      const retryFields = {
        operation: input.operation,
        endpoint: input.endpoint,
        attempt: attemptNumber,
        nextAttempt: attemptNumber + 1,
        maxAttempts,
        delayMs: delay,
        rateLimited: rateLimitDelay > 0,
        error: error instanceof Error ? error.message : String(error),
        ...(input.logContext ?? {})
      };
      if (input.logger) {
        input.logger.warn(retryFields, "openai-compatible request retry scheduled");
      } else {
        console.warn("openai-compatible request retry scheduled", retryFields);
      }
      await waitForRetry(delay, input.signal, input.operation);
    }
  }
  if (lastError instanceof LlmRequestRetryExhaustedError) throw lastError;
  throw new LlmRequestRetryExhaustedError(
    input.operation,
    maxAttempts,
    lastError instanceof Error ? lastError.message : String(lastError)
  );
}

function isRetryableLlmError(error: unknown): boolean {
  if (error instanceof TransientLlmHttpError) return true;
  const status = readNumericErrorProperty(error, "status") ?? readNumericErrorProperty(error, "statusCode");
  if (status !== undefined) return isTransientHttpStatus(status);
  const code = readStringErrorProperty(error, "code");
  if (code && /^(?:ECONN|ENET|EHOST|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_|ERR_(?:NETWORK|SOCKET|STREAM_PREMATURE_CLOSE))/i.test(code)) return true;
  if (error instanceof Error) {
    if (/timed out|timeout|network|connection|fetch failed|socket|closed|reset|terminated|premature|disconnected|broken pipe|econn|enet|ehost|epipe|enotfound|eai_again|und_err/i.test(error.message)) {
      return true;
    }
    if (/^(?:APIConnectionError|APITimeoutError|FetchError|SocketError)$/i.test(error.name)) return true;
  }
  const cause = error && typeof error === "object" && "cause" in error
    ? (error as { cause?: unknown }).cause
    : undefined;
  return cause !== undefined && cause !== error && isRetryableLlmError(cause);
}

function isTransientHttpStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function readRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 0 ? seconds * 1000 : undefined;
  }
  const dateMs = Date.parse(trimmed);
  const delta = dateMs - Date.now();
  return Number.isFinite(dateMs) && delta > 0 ? delta : undefined;
}

async function waitForRetry(delayMs: number, signal: AbortSignal | undefined, operation: string) {
  throwIfSignalAborted(signal, operation);
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError(operation));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizePositiveInteger(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && value !== undefined && value >= 0 ? Math.floor(value) : fallback;
}

function readNumericErrorProperty(error: unknown, key: "status" | "statusCode") {
  if (!error || typeof error !== "object" || !(key in error)) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringErrorProperty(error: unknown, key: "code") {
  if (!error || typeof error !== "object" || !(key in error)) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function startObservation(input: OpenAiCompatibleRequestOptions, internalAttempt: number, requestBody: unknown) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  input.observer?.({
    status: "started",
    operation: input.operation,
    endpoint: input.endpoint,
    startedAt,
    internalAttempt,
    requestBody,
    ...readObservationModel(requestBody),
    ...(input.logContext ? { context: input.logContext } : {})
  });
  return { startedAt, startedAtMs, internalAttempt, requestBody };
}

function finishObservation(
  input: OpenAiCompatibleRequestOptions,
  observed: { startedAt: string; startedAtMs: number; internalAttempt: number; requestBody: unknown },
  response?: unknown
) {
  input.observer?.({
    status: "succeeded",
    operation: input.operation,
    endpoint: input.endpoint,
    startedAt: observed.startedAt,
    elapsedMs: Date.now() - observed.startedAtMs,
    internalAttempt: observed.internalAttempt,
    requestBody: observed.requestBody,
    ...(response !== undefined ? { response } : {}),
    ...readObservationModel(observed.requestBody),
    ...readObservationUsage(response),
    ...(input.logContext ? { context: input.logContext } : {})
  });
}

function failObservation(
  input: OpenAiCompatibleRequestOptions,
  observed: { startedAt: string; startedAtMs: number; internalAttempt: number; requestBody: unknown },
  error: unknown
) {
  input.observer?.({
    status: "failed",
    operation: input.operation,
    endpoint: input.endpoint,
    startedAt: observed.startedAt,
    elapsedMs: Date.now() - observed.startedAtMs,
    error: error instanceof Error ? error.message : String(error),
    internalAttempt: observed.internalAttempt,
    requestBody: observed.requestBody,
    ...readObservationModel(observed.requestBody),
    structuredError: structuredObservationError(error),
    ...(input.logContext ? { context: input.logContext } : {})
  });
}

async function readObservationResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readObservationModel(body: unknown): { model?: string } {
  return isRecord(body) && typeof body.model === "string" ? { model: body.model } : {};
}

function readObservationUsage(response: unknown): { usage?: unknown } {
  if (!isRecord(response)) return {};
  if (response.usage !== undefined) return { usage: response.usage };
  const nestedResponse = isRecord(response.response) ? response.response : undefined;
  return nestedResponse?.usage !== undefined ? { usage: nestedResponse.usage } : {};
}

function structuredObservationError(error: unknown) {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(typeof value?.code === "string" || typeof value?.code === "number" ? { code: value.code } : {}),
    ...(typeof value?.status === "number" ? { status: value.status } : {})
  };
}

function logTimeout(input: OpenAiCompatibleRequestOptions, timeoutMs: number, elapsedMs: number) {
  const fields = {
    operation: input.operation,
    endpoint: input.endpoint,
    timeoutMs,
    elapsedMs,
    ...(input.logContext ?? {})
  };
  if (input.logger) {
    input.logger.warn(fields, "openai-compatible request timed out");
  } else {
    console.warn("openai-compatible request timed out", fields);
  }
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfSignalAborted(signal: AbortSignal | undefined, operation: string) {
  if (signal?.aborted) throw abortError(operation);
}

function abortError(operation: string) {
  return new Error(`${operation} aborted`);
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

class OpenAiCompatibleHttpError extends Error {
  constructor(readonly status: number, text: string) {
    super(`http_${status}:${truncate(text, 240)}`);
  }
}

function openAiCompatibleHttpError(status: number, text: string) {
  return new OpenAiCompatibleHttpError(status, text);
}
