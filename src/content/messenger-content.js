(async () => {
  try {
    const controllerUrl = chrome.runtime.getURL("src/content/messenger-controller.js");
    const { mountMessengerDetector } = await import(controllerUrl);
    await mountMessengerDetector();
  } catch {
    console.warn("PH Red Flag Detector could not start on this page.");
  }
})();
