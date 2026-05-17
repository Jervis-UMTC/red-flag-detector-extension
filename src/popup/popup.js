import { checkApiHealth } from "../shared/api-client.js";
import {
  SUPPORTED_LANGUAGE_MIXES,
  SUPPORTED_RETRIEVAL_MESSAGE_COUNTS,
} from "../shared/constants.js";
import { ensureApiHostPermission } from "../shared/permissions.js";
import { loadSettings, normalizeApiBaseHref, saveSettings } from "../shared/settings.js";

const form = document.getElementById("settingsForm");
const consentGate = document.getElementById("consentGate");
const acceptConsentButton = document.getElementById("acceptConsentButton");

const enabledInput = document.getElementById("enabledInput");
const languageMixInput = document.getElementById("languageMixInput");
const retrievalCountInput = document.getElementById("retrievalCountInput");

const apiUrlInput = document.getElementById("apiUrlInput");
const previewInput = document.getElementById("previewInput");
const statusText = document.getElementById("statusText");
const saveButton = document.getElementById("saveButton");
const testButton = document.getElementById("testButton");

let currentSettings = null;

initPopup();

async function initPopup() {
  populateLanguageMixes();
  populateRetrievalCounts();

  try {
    currentSettings = await loadSettings();
    applySettings(currentSettings);
    
    if (!currentSettings.consentAccepted) {
      showConsentGate();
      setStatus("Pending Consent");
    } else {
      showSettingsForm();
      setStatus("Ready");
    }
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

  acceptConsentButton.addEventListener("click", async () => {
    try {
      acceptConsentButton.disabled = true;
      acceptConsentButton.textContent = "Saving...";
      
      const newSettings = {
        ...currentSettings,
        consentAccepted: true
      };
      
      currentSettings = await saveSettings(newSettings);
      
      showSettingsForm();
      setStatus("Ready");
    } catch (error) {
      setStatus("Error saving consent");
      acceptConsentButton.disabled = false;
      acceptConsentButton.textContent = "Accept & Continue";
    }
  });
}

function showConsentGate() {
  consentGate.style.display = "flex";
  form.style.display = "none";
}

function showSettingsForm() {
  consentGate.style.display = "none";
  form.style.display = "grid";
}

function populateLanguageMixes() {
  for (const languageMix of SUPPORTED_LANGUAGE_MIXES) {
    const option = document.createElement("option");
    option.value = languageMix;
    option.textContent = languageMix.replaceAll("_", " ");
    languageMixInput.append(option);
  }
}

function populateRetrievalCounts() {
  for (const count of SUPPORTED_RETRIEVAL_MESSAGE_COUNTS) {
    const option = document.createElement("option");
    option.value = String(count);
    option.textContent = `Context ${count}`;
    retrievalCountInput.append(option);
  }
}

function applySettings(settings) {
  enabledInput.checked = settings.enabled;
  languageMixInput.value = settings.languageMix;
  retrievalCountInput.value = String(settings.messageRetrievalCount);

  apiUrlInput.value = settings.apiUrl;
  previewInput.checked = settings.showPreviewBeforeSending;
}

async function saveForm() {
  setStatus("Saving...");
  saveButton.disabled = true;

  try {
    const formValues = collectFormSettings();
    const settings = {
      ...currentSettings,
      ...formValues
    };

    const permissionGranted = await ensureApiHostPermission(settings.apiUrl);
    if (!permissionGranted) {
      throw new Error("Chrome permission was not granted for this API host.");
    }

    currentSettings = await saveSettings(settings);
    applySettings(currentSettings);
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
    const formValues = collectFormSettings();
    const permissionGranted = await ensureApiHostPermission(formValues.apiUrl);
    if (!permissionGranted) {
      throw new Error("Chrome permission was not granted for this API host.");
    }

    const health = await checkApiHealth({ apiUrl: formValues.apiUrl });
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
    messageRetrievalCount: retrievalCountInput.value,
    apiUrl: normalizeApiBaseHref(apiUrlInput.value),
    showPreviewBeforeSending: previewInput.checked,
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
