import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMessageWindows,
  buildPredictionPayload,
  cleanMessageText,
  normalizeFormatterMode,
  normalizeLanguageMix,
  normalizeMessages,
} from "../src/shared/normalization.js";

test("normalizeLanguageMix accepts known language mixes", () => {
  assert.equal(normalizeLanguageMix("bislish"), "bislish");
  assert.equal(normalizeLanguageMix(" taglish "), "taglish");
});

test("normalizeLanguageMix falls back for unknown values", () => {
  assert.equal(normalizeLanguageMix("cebuano_english"), "tagalog_bisaya_english");
  assert.equal(normalizeLanguageMix(""), "tagalog_bisaya_english");
  assert.equal(normalizeLanguageMix(undefined), "tagalog_bisaya_english");
});

test("normalizeFormatterMode accepts API-supported formatter modes", () => {
  assert.equal(normalizeFormatterMode("auto"), "auto");
  assert.equal(normalizeFormatterMode("deterministic"), "deterministic");
  assert.equal(normalizeFormatterMode("advanced_llm"), "advanced_llm");
  assert.equal(normalizeFormatterMode("ADVANCED_LLM"), "advanced_llm");
});

test("normalizeFormatterMode falls back to auto for unknown values", () => {
  assert.equal(normalizeFormatterMode("llm"), "auto");
  assert.equal(normalizeFormatterMode(""), "auto");
  assert.equal(normalizeFormatterMode(undefined), "auto");
});

test("cleanMessageText trims, collapses whitespace, and truncates long text", () => {
  const long = `  hello\n\nthere   ${"x".repeat(2000)}  `;
  const cleaned = cleanMessageText(long, { maxLength: 24 });

  assert.equal(cleaned, "hello there xxxxxxxxxxxx");
  assert.equal(cleaned.length, 24);
});

test("normalizeMessages ignores empty text and keeps the latest six", () => {
  const messages = [
    { speaker: "A", text: "first" },
    { speaker: "B", text: "" },
    { speaker: "B", text: "second" },
    { speaker: "A", text: "third" },
    { speaker: "B", text: "fourth" },
    { speaker: "A", text: "fifth" },
    { speaker: "B", text: "sixth" },
    { speaker: "A", text: "seventh" },
  ];

  assert.deepEqual(normalizeMessages(messages), [
    { speaker: "B", text: "second" },
    { speaker: "A", text: "third" },
    { speaker: "B", text: "fourth" },
    { speaker: "A", text: "fifth" },
    { speaker: "B", text: "sixth" },
    { speaker: "A", text: "seventh" },
  ]);
});

test("normalizeMessages maps outgoing messages to speaker A and incoming messages to speaker B", () => {
  const messages = [
    { isOutgoing: true, text: "Asa ka?" },
    { isOutgoing: false, text: "Naa ko sa school." },
    { speaker: "not-valid", text: "Sure ka?" },
  ];

  assert.deepEqual(normalizeMessages(messages), [
    { speaker: "A", text: "Asa ka?" },
    { speaker: "B", text: "Naa ko sa school." },
    { speaker: "B", text: "Sure ka?" },
  ]);
});

test("buildPredictionPayload returns an API-ready request body", () => {
  const payload = buildPredictionPayload({
    languageMix: "bislish",
    formatterMode: "advanced_llm",
    messages: [
      { isOutgoing: true, text: "  Asa ka? " },
      { isOutgoing: false, text: "Naa ko sa school." },
    ],
  });

  assert.deepEqual(payload, {
    language_mix: "bislish",
    formatter_mode: "advanced_llm",
    messages: [
      { speaker: "A", text: "Asa ka?" },
      { speaker: "B", text: "Naa ko sa school." },
    ],
  });
});

test("buildPredictionPayload keeps the latest eighteen messages for API-side windowing", () => {
  const payload = buildPredictionPayload({
    languageMix: "bislish",
    formatterMode: "auto",
    messages: Array.from({ length: 20 }, (_, index) => ({
      speaker: index % 2 === 0 ? "A" : "B",
      text: `message ${index + 1}`,
    })),
  });

  assert.equal(payload.messages.length, 18);
  assert.equal(payload.messages[0].text, "message 3");
  assert.equal(payload.messages.at(-1).text, "message 20");
});

test("buildMessageWindows creates overlapping API-sized windows and includes the latest window", () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    speaker: index % 2 === 0 ? "A" : "B",
    text: `message ${index + 1}`,
  }));

  const windows = buildMessageWindows(messages, { windowSize: 6, stride: 3, maxMessages: 18 });

  assert.deepEqual(
    windows.map((window) => window.map((message) => message.text)),
    [
      ["message 1", "message 2", "message 3", "message 4", "message 5", "message 6"],
      ["message 4", "message 5", "message 6", "message 7", "message 8", "message 9"],
      ["message 5", "message 6", "message 7", "message 8", "message 9", "message 10"],
    ]
  );
});

test("buildMessageWindows keeps only the latest configured scan range", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    speaker: "A",
    text: `message ${index + 1}`,
  }));

  const windows = buildMessageWindows(messages, { windowSize: 6, stride: 3, maxMessages: 9 });

  assert.deepEqual(windows[0].map((message) => message.text), [
    "message 12",
    "message 13",
    "message 14",
    "message 15",
    "message 16",
    "message 17",
  ]);
  assert.deepEqual(windows.at(-1).map((message) => message.text), [
    "message 15",
    "message 16",
    "message 17",
    "message 18",
    "message 19",
    "message 20",
  ]);
});
