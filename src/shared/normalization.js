import {
  DEFAULT_FORMATTER_MODE,
  DEFAULT_LANGUAGE_MIX,
  MAX_ANALYSIS_MESSAGES,
  MAX_MESSAGES,
  MAX_MESSAGE_TEXT_LENGTH,
  SUPPORTED_FORMATTER_MODES,
  SUPPORTED_LANGUAGE_MIXES,
  WINDOW_STRIDE,
} from "./constants.js";

const SUPPORTED_LANGUAGE_MIX_SET = new Set(SUPPORTED_LANGUAGE_MIXES);
const SUPPORTED_FORMATTER_MODE_SET = new Set(SUPPORTED_FORMATTER_MODES);

export function normalizeLanguageMix(languageMix) {
  const normalized = String(languageMix ?? "")
    .trim()
    .toLowerCase();

  return SUPPORTED_LANGUAGE_MIX_SET.has(normalized) ? normalized : DEFAULT_LANGUAGE_MIX;
}

export function normalizeFormatterMode(formatterMode) {
  const normalized = String(formatterMode ?? "")
    .trim()
    .toLowerCase();

  return SUPPORTED_FORMATTER_MODE_SET.has(normalized) ? normalized : DEFAULT_FORMATTER_MODE;
}

export function cleanMessageText(text, options = {}) {
  const maxLength = Math.max(1, options.maxLength ?? MAX_MESSAGE_TEXT_LENGTH);
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

export function normalizeSpeaker(message) {
  const explicitSpeaker = String(message?.speaker ?? "")
    .trim()
    .toUpperCase();

  if (explicitSpeaker === "A" || explicitSpeaker === "B") {
    return explicitSpeaker;
  }

  return message?.isOutgoing === true ? "A" : "B";
}

export function normalizeMessages(messages, options = {}) {
  const maxMessages = Math.max(1, options.maxMessages ?? MAX_MESSAGES);
  const maxTextLength = Math.max(1, options.maxTextLength ?? MAX_MESSAGE_TEXT_LENGTH);

  return Array.isArray(messages)
    ? messages
        .map((message) => ({
          speaker: normalizeSpeaker(message),
          text: cleanMessageText(message?.text, { maxLength: maxTextLength }),
        }))
        .filter((message) => message.text.length > 0)
        .slice(-maxMessages)
    : [];
}

export function buildPredictionPayload({
  languageMix,
  formatterMode,
  maxWindows,
  returnDebug,
  messages,
}) {
  const payload = {
    language_mix: normalizeLanguageMix(languageMix),
    formatter_mode: normalizeFormatterMode(formatterMode),
    messages: normalizeMessages(messages, { maxMessages: MAX_ANALYSIS_MESSAGES }),
  };

  if (Number.isFinite(maxWindows) && maxWindows > 0) {
    payload.max_windows = Math.floor(maxWindows);
  }

  if (returnDebug === true) {
    payload.return_debug = true;
  }

  return payload;
}

export function buildMessageWindows(messages, options = {}) {
  const windowSize = Math.max(1, options.windowSize ?? MAX_MESSAGES);
  const stride = Math.max(1, options.stride ?? WINDOW_STRIDE);
  const maxMessages = Math.max(windowSize, options.maxMessages ?? MAX_ANALYSIS_MESSAGES);
  const normalizedMessages = normalizeMessages(messages, { maxMessages });

  if (normalizedMessages.length === 0) {
    return [];
  }

  if (normalizedMessages.length <= windowSize) {
    return [normalizedMessages];
  }

  const lastStart = normalizedMessages.length - windowSize;
  const starts = [];

  for (let start = 0; start <= lastStart; start += stride) {
    starts.push(start);
  }

  if (starts.at(-1) !== lastStart) {
    starts.push(lastStart);
  }

  return starts.map((start) => normalizedMessages.slice(start, start + windowSize));
}
