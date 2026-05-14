import { checkApiHealth } from "../shared/api-client.js";
import { SUPPORTED_FORMATTER_MODES, SUPPORTED_LANGUAGE_MIXES } from "../shared/constants.js";
import { ensureApiHostPermission } from "../shared/permissions.js";
import { loadSettings, normalizeApiBaseHref, saveSettings } from "../shared/settings.js";

const form = document.getElementById("settingsForm");
const enabledInput = document.getElementById("enabledInput");
const languageMixInput = document.getElementById("languageMixInput");

const apiUrlInput = document.getElementById("apiUrlInput");
const previewInput = document.getElementById("previewInput");
const consentInput = document.getElementById("consentInput");
const statusText = document.getElementById("statusText");
const saveButton = document.getElementById("saveButton");
const testButton = document.getElementById("testButton");

initPopup();

async function initPopup() {
  populateLanguageMixes();


  try {
    const settings = await loadSettings();
    applySettings(settings);
    setStatus("Ready");
  } catch {
    setStatus("Settings unavailable");
    setFormDisabled(true);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveForm();
  });

  testButton.addEventListener("click", async () => {
    await testApi();
  });
}

function populateLanguageMixes() {
  for (const languageMix of SUPPORTED_LANGUAGE_MIXES) {
    const option = document.createElement("option");
    option.value = languageMix;
    option.textContent = languageMix.replaceAll("_", " ");
    languageMixInput.append(option);
  }
}


function applySettings(settings) {
  enabledInput.checked = settings.enabled;
  languageMixInput.value = settings.languageMix;

  apiUrlInput.value = settings.apiUrl;
  previewInput.checked = settings.showPreviewBeforeSending;
  consentInput.checked = settings.consentAccepted;
}

async function saveForm() {
  setStatus("Saving...");
  saveButton.disabled = true;

  try {
    const settings = collectFormSettings();
    const permissionGranted = await ensureApiHostPermission(settings.apiUrl);
    if (!permissionGranted) {
      throw new Error("Chrome permission was not granted for this API host.");
    }

    const saved = await saveSettings(settings);
    applySettings(saved);
    setStatus("Saved");
    
    const originalText = saveButton.textContent;
    saveButton.textContent = "Saved!";
    saveButton.style.backgroundColor = "var(--success)";
    saveButton.style.borderColor = "var(--success)";
    setTimeout(() => {
      saveButton.textContent = originalText;
      saveButton.style.backgroundColor = "";
      saveButton.style.borderColor = "";
    }, 2000);
  } catch (error) {
    setStatus(error.message || "Could not save settings");
  } finally {
    saveButton.disabled = false;
  }
}

async function testApi() {
  setStatus("Testing API...");
  testButton.disabled = true;

  try {
    const settings = collectFormSettings();
    const permissionGranted = await ensureApiHostPermission(settings.apiUrl);
    if (!permissionGranted) {
      throw new Error("Chrome permission was not granted for this API host.");
    }

    const health = await checkApiHealth({ apiUrl: settings.apiUrl });
    setStatus(health.model_loaded === false ? "API running, model not loaded" : "API healthy");
  } catch (error) {
    setStatus(error.message || "API test failed");
  } finally {
    testButton.disabled = false;
  }
}

function collectFormSettings() {
  return {
    enabled: enabledInput.checked,
    languageMix: languageMixInput.value,
    formatterMode: "auto",
    apiUrl: normalizeApiBaseHref(apiUrlInput.value),
    showPreviewBeforeSending: previewInput.checked,
    consentAccepted: consentInput.checked,
  };
}

function setStatus(message) {
  statusText.textContent = message;
}

function setFormDisabled(disabled) {
  for (const element of form.elements) {
    element.disabled = disabled;
  }
}
