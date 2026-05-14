import test from "node:test";
import assert from "node:assert/strict";

import {
  checkApiHealth,
  classifyConversation,
  classifyConversationWindows,
  resolveEndpointUrl,
  validateApiBaseUrl,
} from "../src/shared/api-client.js";

test("validateApiBaseUrl accepts HTTPS and local development origins", () => {
  assert.equal(
    validateApiBaseUrl("https://jerbenjems-ph-redflag-detector-api.hf.space").href,
    "https://jerbenjems-ph-redflag-detector-api.hf.space/"
  );
  assert.equal(validateApiBaseUrl("http://localhost:7860").href, "http://localhost:7860/");
  assert.equal(validateApiBaseUrl("http://127.0.0.1:7860").href, "http://127.0.0.1:7860/");
});

test("validateApiBaseUrl rejects insecure non-local API URLs", () => {
  assert.throws(() => validateApiBaseUrl("http://example.com"), /HTTPS/);
  assert.throws(() => validateApiBaseUrl("not a url"), /valid URL/);
});

test("resolveEndpointUrl appends predict or health endpoints safely", () => {
  assert.equal(
    resolveEndpointUrl("https://example.test/api", "predict"),
    "https://example.test/api/predict"
  );
  assert.equal(
    resolveEndpointUrl("https://example.test/predict", "predict"),
    "https://example.test/predict"
  );
  assert.equal(
    resolveEndpointUrl("https://example.test/api/", "health"),
    "https://example.test/api/health"
  );
});

test("classifyConversation posts normalized payload without credentials", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return jsonResponse({
      label: "red_flag",
      confidence: 0.91,
      risk_level: "high",
      explanation: "Possible red-flag content.",
      language_mix: "bislish",
      message_count_used: 2,
      probabilities: { green_flag: 0.09, red_flag: 0.91 },
      latency_seconds: 0.1,
      formatter_used: "advanced_llm",
      windows_scanned: 3,
      selected_window_index: 2,
      dropped_items_count: 1,
      formatter_warnings: ["Dropped timestamp-only item."],
      risk_policy: "high",
    });
  };

  const result = await classifyConversation({
    apiUrl: "https://example.test",
    languageMix: "bislish",
    formatterMode: "advanced_llm",
    messages: [
      { isOutgoing: true, text: "  Asa ka? " },
      { isOutgoing: false, text: "Naa ko sa school." },
    ],
    fetchImpl,
  });

  assert.equal(request.url, "https://example.test/predict");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.credentials, "omit");
  assert.equal(JSON.parse(request.options.body).formatter_mode, "advanced_llm");
  assert.equal(JSON.parse(request.options.body).messages.length, 2);
  assert.equal(result.label, "red_flag");
  assert.equal(result.risk_level, "high");
  assert.equal(result.formatter_used, "advanced_llm");
  assert.equal(result.windows_scanned, 3);
  assert.equal(result.selected_window_index, 2);
  assert.equal(result.dropped_items_count, 1);
  assert.deepEqual(result.formatter_warnings, ["Dropped timestamp-only item."]);
  assert.equal(result.risk_policy, "high");
});

test("classifyConversation posts up to eighteen messages for API-side windowing", async () => {
  let payload;
  const fetchImpl = async (_url, options) => {
    payload = JSON.parse(options.body);
    return jsonResponse({
      label: "green_flag",
      confidence: 0.94,
      risk_level: "low",
      probabilities: { green_flag: 0.94, red_flag: 0.06 },
    });
  };

  await classifyConversation({
    apiUrl: "https://example.test",
    languageMix: "bislish",
    formatterMode: "auto",
    messages: Array.from({ length: 20 }, (_, index) => ({
      speaker: index % 2 === 0 ? "A" : "B",
      text: `message ${index + 1}`,
    })),
    fetchImpl,
  });

  assert.equal(payload.formatter_mode, "auto");
  assert.equal(payload.messages.length, 18);
  assert.equal(payload.messages[0].text, "message 3");
  assert.equal(payload.messages.at(-1).text, "message 20");
});

test("classifyConversation requires at least one message", async () => {
  await assert.rejects(
    classifyConversation({
      apiUrl: "https://example.test",
      languageMix: "bislish",
      messages: [],
      fetchImpl: async () => jsonResponse({}),
    }),
    /No readable messages/
  );
});

test("classifyConversationWindows scans overlapping windows and returns the highest red risk", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(payload.messages.map((message) => message.text));

    const containsRiskyWindow = payload.messages.some((message) => message.text === "message 8");
    return jsonResponse({
      label: containsRiskyWindow ? "red_flag" : "green_flag",
      confidence: containsRiskyWindow ? 0.88 : 0.93,
      risk_level: containsRiskyWindow ? "high" : "low",
      explanation: containsRiskyWindow ? "Possible red-flag content." : "No red flag detected.",
      language_mix: "bislish",
      message_count_used: payload.messages.length,
      probabilities: containsRiskyWindow
        ? { green_flag: 0.12, red_flag: 0.88 }
        : { green_flag: 0.93, red_flag: 0.07 },
      latency_seconds: 0.1,
    });
  };

  const result = await classifyConversationWindows({
    apiUrl: "https://example.test",
    languageMix: "bislish",
    messages: Array.from({ length: 10 }, (_, index) => ({
      speaker: index % 2 === 0 ? "A" : "B",
      text: `message ${index + 1}`,
    })),
    fetchImpl,
  });

  assert.equal(calls.length, 3);
  assert.equal(result.label, "red_flag");
  assert.equal(result.confidence, 0.88);
  assert.equal(result.scan_count, 3);
  assert.equal(result.window_index, 2);
  assert.deepEqual(calls.at(-1), [
    "message 5",
    "message 6",
    "message 7",
    "message 8",
    "message 9",
    "message 10",
  ]);
});

test("classifyConversationWindows uses one request for six or fewer messages", async () => {
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    return jsonResponse({
      label: "green_flag",
      confidence: 0.94,
      risk_level: "low",
      probabilities: { green_flag: 0.94, red_flag: 0.06 },
    });
  };

  const result = await classifyConversationWindows({
    apiUrl: "https://example.test",
    languageMix: "bislish",
    messages: [{ speaker: "A", text: "hello" }],
    fetchImpl,
  });

  assert.equal(requestCount, 1);
  assert.equal(result.scan_count, 1);
});

test("classifyConversation reports API errors without leaking internals", async () => {
  await assert.rejects(
    classifyConversation({
      apiUrl: "https://example.test",
      languageMix: "bislish",
      messages: [{ speaker: "A", text: "Hello" }],
      fetchImpl: async () => jsonResponse({ detail: "stack trace" }, { ok: false, status: 500 }),
    }),
    /API request failed/
  );
});

test("checkApiHealth calls the health endpoint", async () => {
  let calledUrl = "";
  const result = await checkApiHealth({
    apiUrl: "https://example.test/api",
    fetchImpl: async (url) => {
      calledUrl = url;
      return jsonResponse({ status: "ok", model_loaded: true });
    },
  });

  assert.equal(calledUrl, "https://example.test/api/health");
  assert.equal(result.status, "ok");
  assert.equal(result.model_loaded, true);
});

function jsonResponse(body, overrides = {}) {
  return {
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    async json() {
      return body;
    },
  };
}
