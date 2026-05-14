import { checkApiHealth, classifyConversation, RedFlagApiError } from "../shared/api-client.js";
import { MESSAGE_TYPES } from "../shared/constants.js";
import { loadSettings, saveSettings } from "../shared/settings.js";

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await loadSettings().catch(() => null);
  if (!settings) {
    await saveSettings({});
  }
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  handleMessage(request)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));

  return true;
});

async function handleMessage(request) {
  switch (request?.type) {
    case MESSAGE_TYPES.GET_SETTINGS:
      return loadSettings();

    case MESSAGE_TYPES.CHECK_HEALTH: {
      const settings = await loadSettings();
      return checkApiHealth({ apiUrl: settings.apiUrl });
    }

    case MESSAGE_TYPES.CLASSIFY_CONVERSATION: {
      const settings = await loadSettings();
      if (!settings.enabled) {
        throw new RedFlagApiError("The extension is paused. Enable it from the popup.", "DISABLED");
      }

      return classifyConversation({
        apiUrl: settings.apiUrl,
        languageMix: request.languageMix ?? settings.languageMix,
        formatterMode: request.formatterMode ?? settings.formatterMode,
        messages: request.messages,
      });
    }

    default:
      throw new RedFlagApiError("Unknown extension request.", "UNKNOWN_MESSAGE");
  }
}

function serializeError(error) {
  return {
    message: error?.message || "Something went wrong.",
    code: error?.code || "UNKNOWN_ERROR",
  };
}
