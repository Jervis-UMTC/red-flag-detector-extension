import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPredictionPayload,
  cleanMessageText,
  normalizeFormatterMode,
  normalizeLanguageMix,
  normalizeMessages,
  normalizeRetrievalMessageCount,
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
  assert.equal(normalizeFormatterMode("google_llm"), "google_llm");
  assert.equal(normalizeFormatterMode("GOOGLE_LLM"), "google_llm");
});

test("normalizeFormatterMode falls back to auto for unknown values", () => {
  assert.equal(normalizeFormatterMode("llm"), "auto");
  assert.equal(normalizeFormatterMode(""), "auto");
  assert.equal(normalizeFormatterMode(undefined), "auto");
});

test("normalizeRetrievalMessageCount accepts supported retrieval counts", () => {
  assert.equal(normalizeRetrievalMessageCount(5), 5);
  assert.equal(normalizeRetrievalMessageCount("10"), 10);
  assert.equal(normalizeRetrievalMessageCount(20), 20);
});

test("normalizeRetrievalMessageCount falls back for unsupported retrieval counts", () => {
  assert.equal(normalizeRetrievalMessageCount(7), 20);
  assert.equal(normalizeRetrievalMessageCount("all"), 20);
  assert.equal(normalizeRetrievalMessageCount(undefined), 20);
});

test("cleanMessageText trims, collapses whitespace, and truncates long text", () => {
  const long = `  hello\n\nthere   ${"x".repeat(2000)}  `;
  const cleaned = cleanMessageText(long, { maxLength: 24 });

  assert.equal(cleaned, "hello there xxxxxxxxxxxx");
  assert.equal(cleaned.length, 24);
});

test("normalizeMessages ignores empty text and keeps up to the full context limit by default", () => {
  const messages = Array.from({ length: 22 }, (_value, index) => ({
    speaker: index % 2 === 0 ? "A" : "B",
    text: index === 1 ? "" : `message ${index + 1}`,
  }));

  const normalized = normalizeMessages(messages);

  assert.equal(normalized.length, 20);
  assert.equal(normalized[0].text, "message 3");
  assert.equal(normalized.at(-1).text, "message 22");
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
    formatterMode: "google_llm",
    messages: [
      { isOutgoing: true, text: "  Asa ka? " },
      { isOutgoing: false, text: "Naa ko sa school." },
    ],
  });

  assert.deepEqual(payload, {
    language_mix: "bislish",
    formatter_mode: "google_llm",
    messages: [
      { speaker: "A", text: "Asa ka?" },
      { speaker: "B", text: "Naa ko sa school." },
    ],
  });
});

test("buildPredictionPayload keeps up to twenty selected context messages", () => {
  const payload = buildPredictionPayload({
    languageMix: "bislish",
    formatterMode: "auto",
    messages: Array.from({ length: 22 }, (_, index) => ({
      speaker: index % 2 === 0 ? "A" : "B",
      text: `message ${index + 1}`,
    })),
  });

  assert.equal(payload.messages.length, 20);
  assert.equal(payload.messages[0].text, "message 3");
  assert.equal(payload.messages.at(-1).text, "message 22");
});
