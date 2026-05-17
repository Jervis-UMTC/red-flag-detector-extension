export const DEFAULT_API_BASE_URL = "https://jerbenjems-ph-redflag-detector-api.hf.space";

export const DEFAULT_LANGUAGE_MIX = "tagalog_bisaya_english";
export const DEFAULT_FORMATTER_MODE = "auto";

export const SUPPORTED_LANGUAGE_MIXES = Object.freeze([
  "english",
  "tagalog",
  "bisaya",
  "taglish",
  "bislish",
  "tagalog_bisaya",
  "tagalog_bisaya_english",
]);

export const SUPPORTED_FORMATTER_MODES = Object.freeze([
  "auto",
  "deterministic",
  "google_llm",
]);

export const MAX_ANALYSIS_MESSAGES = 20;
export const MAX_MESSAGE_TEXT_LENGTH = 800;
export const REQUEST_TIMEOUT_MS = 20000;
export const SUPPORTED_RETRIEVAL_MESSAGE_COUNTS = Object.freeze([5, 10, 20]);
export const DEFAULT_RETRIEVAL_MESSAGE_COUNT = 20;

export const MESSAGE_TYPES = Object.freeze({
  CLASSIFY_CONVERSATION: "PH_RED_FLAG_CLASSIFY_CONVERSATION",
  CHECK_HEALTH: "PH_RED_FLAG_CHECK_HEALTH",
  GET_SETTINGS: "PH_RED_FLAG_GET_SETTINGS",
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  apiUrl: DEFAULT_API_BASE_URL,
  languageMix: DEFAULT_LANGUAGE_MIX,
  formatterMode: DEFAULT_FORMATTER_MODE,
  showPreviewBeforeSending: false,
  messageRetrievalCount: DEFAULT_RETRIEVAL_MESSAGE_COUNT,
  consentAccepted: false,
});

export const RISK_COPY = Object.freeze({
  red_flag: {
    title: "Possible red flag detected",
    tone: "danger",
  },
  green_flag: {
    title: "No red flag detected",
    tone: "safe",
  },
});
