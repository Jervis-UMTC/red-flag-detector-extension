import { DEFAULT_SETTINGS } from "./constants.js";
import { normalizeFormatterMode, normalizeLanguageMix } from "./normalization.js";
import { normalizeApiBaseUrl } from "./api-client.js";

const STORAGE_KEY = "phRedFlagDetectorSettings";

export async function loadSettings(storageArea = getStorageArea()) {
  const stored = await storageGet(storageArea, STORAGE_KEY);
  return normalizeSettings(stored?.[STORAGE_KEY]);
}

export async function saveSettings(settings, storageArea = getStorageArea()) {
  const normalized = normalizeSettings(settings);
  await storageSet(storageArea, { [STORAGE_KEY]: normalized });
  return normalized;
}

export function normalizeSettings(settings = {}) {
  let apiUrl = DEFAULT_SETTINGS.apiUrl;

  try {
    apiUrl = normalizeApiBaseHref(settings.apiUrl ?? DEFAULT_SETTINGS.apiUrl);
  } catch {
    apiUrl = DEFAULT_SETTINGS.apiUrl;
  }

  return {
    enabled: settings.enabled !== false,
    apiUrl,
    languageMix: normalizeLanguageMix(settings.languageMix),
    formatterMode: normalizeFormatterMode(settings.formatterMode),
    showPreviewBeforeSending: settings.showPreviewBeforeSending === true,
    consentAccepted: settings.consentAccepted === true,
  };
}

export function normalizeApiBaseHref(apiUrl) {
  const url = normalizeApiBaseUrl(apiUrl);
  return url.href.replace(/\/+$/g, "");
}

function getStorageArea() {
  if (!globalThis.chrome?.storage?.local) {
    throw new Error("Chrome storage is unavailable.");
  }

  return globalThis.chrome.storage.local;
}

function storageGet(storageArea, key) {
  return new Promise((resolve, reject) => {
    try {
      storageArea.get(key, resolve);
    } catch (error) {
      reject(error);
    }
  });
}

function storageSet(storageArea, value) {
  return new Promise((resolve, reject) => {
    try {
      storageArea.set(value, resolve);
    } catch (error) {
      reject(error);
    }
  });
}
