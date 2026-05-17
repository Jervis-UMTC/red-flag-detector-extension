import test from "node:test";
import assert from "node:assert/strict";

import { hostPermissionPatternForApiUrl } from "../src/shared/permissions.js";
import { normalizeApiBaseHref, normalizeSettings } from "../src/shared/settings.js";

test("normalizeApiBaseHref preserves API path but removes trailing slash", () => {
  assert.equal(normalizeApiBaseHref("https://example.test/api/"), "https://example.test/api");
});

test("normalizeApiBaseHref strips known endpoint suffixes from pasted URLs", () => {
  assert.equal(normalizeApiBaseHref("https://example.test/api/predict"), "https://example.test/api");
  assert.equal(normalizeApiBaseHref("https://example.test/health/"), "https://example.test");
});

test("normalizeApiBaseHref converts Hugging Face Space pages to runtime URLs", () => {
  assert.equal(
    normalizeApiBaseHref("https://huggingface.co/spaces/jerbenjems/ph-redflag-detector-api"),
    "https://jerbenjems-ph-redflag-detector-api.hf.space"
  );
});

test("normalizeSettings keeps conservative defaults", () => {
  assert.deepEqual(normalizeSettings({ languageMix: "unknown", apiUrl: "http://example.test" }), {
    enabled: true,
    apiUrl: "https://jerbenjems-ph-redflag-detector-api.hf.space",
    languageMix: "tagalog_bisaya_english",
    formatterMode: "auto",
    showPreviewBeforeSending: false,
    consentAccepted: false,
  });
});

test("normalizeSettings keeps a supported formatter mode", () => {
  assert.equal(normalizeSettings({ formatterMode: "google_llm" }).formatterMode, "google_llm");
  assert.equal(normalizeSettings({ formatterMode: "unsupported" }).formatterMode, "auto");
});

test("hostPermissionPatternForApiUrl creates a narrow origin pattern", () => {
  assert.equal(hostPermissionPatternForApiUrl("https://example.test/api"), "https://example.test/*");
  assert.equal(
    hostPermissionPatternForApiUrl("https://huggingface.co/spaces/jerbenjems/ph-redflag-detector-api"),
    "https://jerbenjems-ph-redflag-detector-api.hf.space/*"
  );
  assert.equal(hostPermissionPatternForApiUrl("http://localhost:7860"), "http://localhost/*");
});
