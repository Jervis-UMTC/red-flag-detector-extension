import { REQUEST_TIMEOUT_MS } from "./constants.js";
import { buildMessageWindows, buildPredictionPayload } from "./normalization.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const KNOWN_ENDPOINTS = new Set(["health", "predict"]);

export class RedFlagApiError extends Error {
  constructor(message, code = "API_ERROR") {
    super(message);
    this.name = "RedFlagApiError";
    this.code = code;
  }
}

export function validateApiBaseUrl(apiUrl) {
  let url;

  try {
    url = new URL(String(apiUrl ?? "").trim());
  } catch {
    throw new RedFlagApiError("Enter a valid URL for the API.", "INVALID_API_URL");
  }

  const isLocalHttp = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new RedFlagApiError("Use an HTTPS API URL, or localhost for development.", "INSECURE_API_URL");
  }

  url.hash = "";
  return url;
}

export function normalizeApiBaseUrl(apiUrl) {
  const url = toHuggingFaceRuntimeUrl(validateApiBaseUrl(apiUrl));
  removeKnownEndpointSuffix(url);
  url.search = "";
  url.hash = "";
  return url;
}

export function resolveEndpointUrl(apiUrl, endpoint) {
  const url = normalizeApiBaseUrl(apiUrl);
  const cleanEndpoint = String(endpoint).replace(/^\/+|\/+$/g, "");
  const normalizedPath = url.pathname.replace(/\/+$/g, "");

  if (normalizedPath.endsWith(`/${cleanEndpoint}`)) {
    url.pathname = normalizedPath;
  } else {
    url.pathname = `${normalizedPath}/${cleanEndpoint}`;
  }

  url.search = "";
  return url.href;
}

export async function classifyConversation({
  apiUrl,
  languageMix,
  formatterMode,
  maxWindows,
  returnDebug,
  messages,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== "function") {
    throw new RedFlagApiError("Network requests are not available in this browser.", "FETCH_UNAVAILABLE");
  }

  const payload = buildPredictionPayload({
    languageMix,
    formatterMode,
    maxWindows,
    returnDebug,
    messages,
  });
  if (payload.messages.length === 0) {
    throw new RedFlagApiError("No readable messages found in the current conversation.", "NO_MESSAGES");
  }

  const responseBody = await postJson({
    fetchImpl,
    url: resolveEndpointUrl(apiUrl, "predict"),
    body: payload,
    timeoutMs,
  });

  return normalizePredictionResponse(responseBody);
}

export async function classifyConversationWindows({
  apiUrl,
  languageMix,
  formatterMode,
  messages,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const windows = buildMessageWindows(messages);

  if (windows.length === 0) {
    throw new RedFlagApiError("No readable messages found in the current conversation.", "NO_MESSAGES");
  }

  const results = [];

  for (const [index, windowMessages] of windows.entries()) {
    const result = await classifyConversation({
      apiUrl,
      languageMix,
      formatterMode,
      messages: windowMessages,
      fetchImpl,
      timeoutMs,
    });

    results.push({
      ...result,
      scan_count: windows.length,
      window_index: index + 1,
      message_count_scanned: messages.length,
    });
  }

  return results.reduce((best, current) =>
    redRiskScore(current) > redRiskScore(best) ? current : best
  );
}

export async function checkApiHealth({
  apiUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== "function") {
    throw new RedFlagApiError("Network requests are not available in this browser.", "FETCH_UNAVAILABLE");
  }

  return postOrGetJson({
    fetchImpl,
    url: resolveEndpointUrl(apiUrl, "health"),
    timeoutMs,
  });
}

async function postJson({ fetchImpl, url, body, timeoutMs }) {
  const { signal, cleanup } = createTimeoutSignal(timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      signal,
    });

    return await parseJsonResponse(response);
  } catch (error) {
    throw toApiError(error);
  } finally {
    cleanup();
  }
}

async function postOrGetJson({ fetchImpl, url, timeoutMs }) {
  const { signal, cleanup } = createTimeoutSignal(timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      credentials: "omit",
      cache: "no-store",
      signal,
    });

    return await parseJsonResponse(response);
  } catch (error) {
    throw toApiError(error);
  } finally {
    cleanup();
  }
}

async function parseJsonResponse(response) {
  if (!response?.ok) {
    if (response?.status === 404) {
      throw new RedFlagApiError(
        "API endpoint was not found (404). Check the API base URL in settings.",
        "HTTP_NOT_FOUND"
      );
    }

    const status = Number.isInteger(response?.status) ? ` (${response.status})` : "";
    throw new RedFlagApiError(`API request failed${status}. Try again later.`, "HTTP_ERROR");
  }

  try {
    return await response.json();
  } catch {
    throw new RedFlagApiError("The API returned an unreadable response.", "INVALID_JSON");
  }
}

function normalizePredictionResponse(data) {
  const label = data?.label === "red_flag" ? "red_flag" : "green_flag";
  const confidence = clampProbability(data?.confidence);
  const probabilities = {
    green_flag: clampProbability(data?.probabilities?.green_flag),
    red_flag: clampProbability(data?.probabilities?.red_flag),
  };

  return {
    label,
    confidence,
    risk_level: cleanText(data?.risk_level) || (label === "red_flag" ? "medium" : "low"),
    explanation: cleanText(data?.explanation),
    language_mix: cleanText(data?.language_mix),
    message_count_used: Number.isFinite(data?.message_count_used) ? data.message_count_used : undefined,
    probabilities,
    latency_seconds: Number.isFinite(data?.latency_seconds) ? data.latency_seconds : undefined,
    formatter_used: cleanText(data?.formatter_used),
    windows_scanned: positiveIntegerOrUndefined(data?.windows_scanned),
    selected_window_index: positiveIntegerOrUndefined(data?.selected_window_index),
    dropped_items_count: nonNegativeIntegerOrUndefined(data?.dropped_items_count),
    formatter_warnings: normalizeWarnings(data?.formatter_warnings),
    risk_policy: cleanText(data?.risk_policy),
  };
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function clampProbability(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.min(1, Math.max(0, number));
}

function positiveIntegerOrUndefined(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function nonNegativeIntegerOrUndefined(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

function normalizeWarnings(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(cleanText).filter(Boolean);
}

function toHuggingFaceRuntimeUrl(url) {
  if (url.hostname !== "huggingface.co") {
    return url;
  }

  const [resourceType, owner, space] = url.pathname.split("/").filter(Boolean);
  if (resourceType !== "spaces" || !owner || !space) {
    return url;
  }

  const subdomain = `${owner}-${space}`.toLowerCase().replaceAll("_", "-");
  if (!/^[a-z0-9-]+$/u.test(subdomain)) {
    return url;
  }

  return new URL(`https://${subdomain}.hf.space`);
}

function removeKnownEndpointSuffix(url) {
  const pathSegments = url.pathname.split("/").filter(Boolean);
  while (KNOWN_ENDPOINTS.has(pathSegments.at(-1))) {
    pathSegments.pop();
  }

  url.pathname = pathSegments.length > 0 ? `/${pathSegments.join("/")}` : "/";
}

function redRiskScore(result) {
  const redProbability = Number(result?.probabilities?.red_flag);
  if (Number.isFinite(redProbability)) {
    return redProbability;
  }

  const confidence = Number(result?.confidence);
  if (!Number.isFinite(confidence)) {
    return 0;
  }

  return result?.label === "red_flag" ? confidence : 1 - confidence;
}

function createTimeoutSignal(timeoutMs) {
  if (typeof AbortController !== "function") {
    return { signal: undefined, cleanup: () => {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

function toApiError(error) {
  if (error instanceof RedFlagApiError) {
    return error;
  }

  if (error?.name === "AbortError") {
    return new RedFlagApiError("The API took too long to respond. Try again shortly.", "TIMEOUT");
  }

  return new RedFlagApiError("Could not reach the red-flag detection API.", "NETWORK_ERROR");
}
