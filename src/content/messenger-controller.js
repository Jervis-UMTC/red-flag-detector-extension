import { MAX_ANALYSIS_MESSAGES, MESSAGE_TYPES, RISK_COPY } from "../shared/constants.js";
import { normalizeMessages } from "../shared/normalization.js";
import { loadSettings, saveSettings } from "../shared/settings.js";

const HOST_ID = "ph-red-flag-detector-root";
const MAX_VISIBLE_CANDIDATES = 80;
const NO_MESSAGES_TEXT = "No readable recent messages found in the visible conversation.";
const MONTH_NAMES = "jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december";
const WEEKDAY_NAMES = "mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday";
const MERIDIEM = "(?:a\\.?m\\.?|p\\.?m\\.?)";
const CLOCK_TIME = `\\d{1,2}:\\d{2}(?:\\s*${MERIDIEM})?`;
const DATE_METADATA_PATTERNS = [
  new RegExp(`^${CLOCK_TIME}$`, "iu"),
  new RegExp(`^(?:today|yesterday)(?:\\s+at)?\\s+${CLOCK_TIME}$`, "iu"),
  new RegExp(`^(?:${WEEKDAY_NAMES})(?:,)?(?:\\s+at)?\\s+${CLOCK_TIME}$`, "iu"),
  new RegExp(`^(?:${MONTH_NAMES})\\s+\\d{1,2}(?:,\\s*\\d{4})?(?:\\s+at\\s+${CLOCK_TIME})?$`, "iu"),
  /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:,?\s+\d{1,2}:\d{2}(?:\s*(?:a\.?m\.?|p\.?m\.?))?)?$/iu,
];
const EXACT_METADATA_TEXT = new Set([
  "active now",
  "delivered",
  "edited",
  "read",
  "seen",
  "sent",
  "sending",
  "today",
  "typing...",
  "you",
  "yesterday",
]);
const REPLY_CONTEXT_PATTERNS = [
  /^you replied to .+$/iu,
  /^(?!i\s).+ replied to you$/iu,
  /^(?!i\s).+ replied to .+$/iu,
  /^replying to .+$/iu,
];
const URL_ONLY_PATTERN = /^https?:\/\/\S+$/iu;

export async function mountMessengerDetector() {
  if (document.getElementById(HOST_ID)) {
    return;
  }

  const host = document.createElement("div");
  host.id = HOST_ID;
  document.documentElement.append(host);

  const shadow = host.attachShadow({ mode: "open" });
  const app = new MessengerDetectorApp(shadow);
  await app.mount();
}

export function collectVisibleMessengerMessages(doc = document) {
  const root = findConversationRoot(doc);
  const rootRect = getUsableRect(root);
  const conversationRect = inferConversationColumnRect(doc, root, rootRect);
  const conversationTitles = findConversationTitles(doc, root, rootRect);
  const mainTitle = conversationTitles.length > 0 ? conversationTitles[0] : "Other";
  const selectors = [
    '[role="main"] [dir="auto"]',
    '[aria-label="Messages" i] [dir="auto"]',
    '[aria-label*="message" i] [dir="auto"]',
    'div[data-pagelet*="Messenger" i] [dir="auto"]',
  ];

  const elements = Array.from(root.querySelectorAll(selectors.join(",")));
  const seen = new Set();
  const textItems = [];

  for (const element of elements) {
    const text = normalizeDomText(element.textContent);
    if (!isPotentialMessengerTextElement(element, text)) {
      continue;
    }

    const rect = getUsableRect(element);
    const normalizedKey = `${Math.round(rect.top / 6)}:${Math.round(rect.left / 6)}:${text}`;

    if (seen.has(normalizedKey)) {
      continue;
    }

    seen.add(normalizedKey);
    textItems.push({
      element,
      text,
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      isOutgoing: inferOutgoingMessage(element, rect, rootRect),
    });
  }

  const candidates = filterMessengerTextItems(textItems, {
    blockedExactTexts: conversationTitles,
    conversationRect,
  }).map((item) => ({
    text: item.text,
    isOutgoing: item.isOutgoing,
    speaker: item.isOutgoing ? "Me" : mainTitle,
    top: item.top,
    left: item.left,
  }));

  const maxMessages = Math.min(MAX_ANALYSIS_MESSAGES, MAX_VISIBLE_CANDIDATES);
  return candidates.slice(-maxMessages);
}

class MessengerDetectorApp {
  constructor(root) {
    this.root = root;
    this.state = {
      busy: false,
      status: "Ready",
      result: null,
      error: "",
      previewMessages: null,
      awaitingConsent: false,
      collapsed: false,
    };
  }

  async mount() {
    this.root.append(createStyle());
    this.container = document.createElement("section");
    this.container.className = "rfd-panel";
    this.container.setAttribute("aria-label", "PH Red Flag Detector");
    this.root.append(this.container);
    this.render();
  }

  render() {
    this.container.replaceChildren();

    const header = document.createElement("header");
    header.className = "rfd-header";
    const titleContainer = document.createElement("div");
    titleContainer.className = "rfd-title-group";
    titleContainer.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path>
        <line x1="4" y1="22" x2="4" y2="15"></line>
      </svg>
      <strong>PH Red Flag Detector</strong>
    `;
    header.append(titleContainer);
    
    const headerRight = document.createElement("div");
    headerRight.style.display = "flex";
    headerRight.style.alignItems = "center";
    headerRight.style.gap = "8px";
    
    const statusText = createTextElement("span", this.state.status, "rfd-status");
    
    const collapseBtn = document.createElement("button");
    collapseBtn.className = "rfd-button-quiet";
    collapseBtn.setAttribute("aria-label", this.state.collapsed ? "Expand panel" : "Collapse panel");
    collapseBtn.innerHTML = this.state.collapsed 
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
    collapseBtn.addEventListener("click", () => this.setState({ collapsed: !this.state.collapsed }));
    
    headerRight.append(statusText, collapseBtn);
    header.append(headerRight);

    if (this.state.collapsed) {
      this.container.append(header);
      return;
    }

    const body = document.createElement("div");
    body.className = "rfd-body";

    if (this.state.error) {
      const error = createTextElement("p", this.state.error, "rfd-message rfd-error");
      error.setAttribute("role", "alert");
      body.append(error);
    } else if (this.state.result) {
      body.append(createResultView(this.state.result));
    } else if (this.state.awaitingConsent) {
      body.append(createConsentView(() => this.acceptConsentAndAnalyze(), () => this.cancelPendingFlow()));
    } else if (this.state.previewMessages) {
      body.append(createPreviewView(
        this.state.previewMessages,
        () => this.sendMessages(this.state.previewMessages),
        () => this.cancelPendingFlow(),
        (index) => this.removePreviewMessage(index)
      ));
    } else {
      const message = createTextElement("p", "Manual scan only. Visible messages are sent only after you click analyze.", "rfd-message");
      body.append(message);
    }

    const actions = document.createElement("footer");
    actions.className = "rfd-actions";

    const analyzeButton = createButton("", "primary", () => this.startAnalysis());
    if (this.state.busy) {
      analyzeButton.innerHTML = `
        <svg class="rfd-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
        </svg>
        Checking...
      `;
    } else {
      analyzeButton.textContent = "Analyze";
    }
    analyzeButton.disabled = this.state.busy || this.state.awaitingConsent || Boolean(this.state.previewMessages);
    actions.append(analyzeButton);

    const clearButton = createButton("Clear", "secondary", () => this.resetResult());
    clearButton.disabled = this.state.busy || (!this.state.result && !this.state.error);
    actions.append(clearButton);

    this.container.append(header, body, actions);
  }

  async startAnalysis() {
    this.setState({ busy: true, status: "Reading", error: "", result: null, previewMessages: null });

    try {
      const settings = await loadSettings();
      if (!settings.enabled) {
        this.setState({
          busy: false,
          status: "Paused",
          error: "The extension is paused. Enable it from the popup.",
        });
        return;
      }

      const messages = collectVisibleMessengerMessages();
      if (messages.length === 0) {
        this.setState({ busy: false, status: "No messages", error: NO_MESSAGES_TEXT });
        return;
      }

      if (!settings.consentAccepted) {
        this.pendingMessages = messages;
        this.setState({ busy: false, status: "Consent", awaitingConsent: true });
        return;
      }

      if (settings.showPreviewBeforeSending) {
        this.setState({ busy: false, status: "Preview", previewMessages: messages });
        return;
      }

      await this.sendMessages(messages);
    } catch (error) {
      this.setState({ busy: false, status: "Error", error: error.message || "Unable to analyze this conversation." });
    }
  }

  async acceptConsentAndAnalyze() {
    const settings = await loadSettings();
    await saveSettings({ ...settings, consentAccepted: true });
    const messages = this.pendingMessages || [];
    this.pendingMessages = null;

    if (settings.showPreviewBeforeSending) {
      this.setState({ awaitingConsent: false, status: "Preview", previewMessages: messages });
      return;
    }

    await this.sendMessages(messages);
  }

  async sendMessages(messages) {
    this.setState({ busy: true, status: "Checking", error: "", result: null, previewMessages: null, awaitingConsent: false });

    try {
      const settings = await loadSettings();
      const result = await sendRuntimeMessage({
        type: MESSAGE_TYPES.CLASSIFY_CONVERSATION,
        languageMix: settings.languageMix,
        formatterMode: settings.formatterMode,
        messages,
      });

      this.setState({ busy: false, status: "Done", result });
    } catch (error) {
      this.setState({ busy: false, status: "Error", error: error.message || "Unable to reach the detector API." });
    }
  }

  cancelPendingFlow() {
    this.pendingMessages = null;
    this.setState({
      busy: false,
      status: "Ready",
      awaitingConsent: false,
      previewMessages: null,
      error: "",
    });
  }

  resetResult() {
    this.setState({ status: "Ready", result: null, error: "" });
  }

  removePreviewMessage(indexToRemove) {
    const previewMessages = this.state.previewMessages?.filter((_message, index) => index !== indexToRemove) ?? [];
    this.setState({
      status: previewMessages.length > 0 ? "Preview" : "No messages",
      previewMessages,
    });
  }

  setState(nextState) {
    this.state = { ...this.state, ...nextState };
    this.render();
  }
}

function createResultView(result) {
  const copy = RISK_COPY[result.label] ?? RISK_COPY.green_flag;
  const wrapper = document.createElement("div");
  wrapper.className = `rfd-result rfd-result-${copy.tone}`;
  wrapper.setAttribute("role", "status");

  wrapper.append(createTextElement("p", copy.title, "rfd-result-title"));

  const confidence = Math.round(Number(result.confidence ?? 0) * 100);
  const color = copy.tone === "danger" ? "#dc2626" : "#16a34a";
  
  const metaContainer = document.createElement("div");
  metaContainer.className = "rfd-meta-container";

  const riskText = createTextElement("span", `Risk: ${result.risk_level || "unknown"}`, "rfd-meta-risk");
  
  const chartWrapper = document.createElement("div");
  chartWrapper.className = "rfd-confidence-chart-wrapper";
  
  const chart = document.createElement("div");
  chart.className = "rfd-confidence-chart";
  chart.style.background = `conic-gradient(${color} ${confidence}%, #e2e8f0 0)`;
  
  const label = createTextElement("span", `Confidence: ${confidence}%`, "rfd-meta-confidence");
  
  chartWrapper.append(chart, label);
  metaContainer.append(riskText, chartWrapper);

  wrapper.append(metaContainer);

  if (result.explanation) {
    wrapper.append(createTextElement("p", result.explanation, "rfd-message"));
  }

  return wrapper;
}

function createConsentView(onContinue, onCancel) {
  const wrapper = document.createElement("div");
  wrapper.className = "rfd-consent";
  wrapper.append(createTextElement("p", "Send the latest visible messages to the configured API for analysis?", "rfd-message"));

  const actions = document.createElement("div");
  actions.className = "rfd-inline-actions";
  actions.append(createButton("Continue", "primary", onContinue));
  actions.append(createButton("Cancel", "secondary", onCancel));
  wrapper.append(actions);

  return wrapper;
}

function createPreviewView(messages, onContinue, onCancel, onRemove) {
  const wrapper = document.createElement("div");
  wrapper.className = "rfd-preview";
  wrapper.append(createTextElement("p", `Visible messages ready to send (${messages.length})`, "rfd-result-title"));

  const list = document.createElement("ol");
  list.className = "rfd-preview-list";

  if (messages.length === 0) {
    wrapper.append(createTextElement("p", "No messages selected.", "rfd-message"));
  }

  for (const [index, message] of messages.entries()) {
    const item = document.createElement("li");
    item.className = "rfd-preview-item";

    const messageBody = document.createElement("span");
    messageBody.className = "rfd-preview-text";
    messageBody.append(createTextElement("span", `${message.speaker}: `, "rfd-speaker"));
    messageBody.append(document.createTextNode(message.text));

    const removeButton = createButton("x", "quiet", () => onRemove(index), {
      ariaLabel: `Remove message ${index + 1}`,
      className: "rfd-remove-button",
    });

    item.append(messageBody, removeButton);
    list.append(item);
  }

  const actions = document.createElement("div");
  actions.className = "rfd-inline-actions";
  actions.append(createButton("Send", "primary", onContinue, { disabled: messages.length === 0 }));
  actions.append(createButton("Cancel", "secondary", onCancel));

  if (messages.length > 0) {
    wrapper.append(list);
  }
  wrapper.append(actions);
  return wrapper;
}

function createButton(label, variant, onClick, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `rfd-button rfd-button-${variant}${options.className ? ` ${options.className}` : ""}`;
  button.textContent = label;
  if (options.ariaLabel) {
    button.setAttribute("aria-label", options.ariaLabel);
  }
  button.disabled = options.disabled === true;
  button.addEventListener("click", onClick);
  return button;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function formatFormatterUsed(formatterUsed) {
  const normalized = String(formatterUsed ?? "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return "";
  }

  if (normalized === "advanced_llm" || normalized === "advanced" || normalized === "google_llm" || normalized === "google") {
    return "Advanced LLM";
  }

  if (normalized === "deterministic") {
    return "deterministic";
  }

  return normalized.replaceAll("_", " ");
}

function createTextElement(tagName, text, className = "") {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  element.textContent = text;
  return element;
}

function createStyle() {
  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    .rfd-panel {
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(226, 232, 240, 0.8);
      border-radius: 12px;
      box-shadow: 0 12px 36px rgba(15, 23, 42, 0.12), 0 4px 12px rgba(15, 23, 42, 0.05);
      color: #1e293b;
      font-size: 13px;
      line-height: 1.5;
      overflow: hidden;
    }

    .rfd-header {
      align-items: center;
      background: #ffffff;
      border-bottom: 1px solid #e2e8f0;
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 16px;
    }

    .rfd-header strong {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: -0.01em;
    }

    .rfd-status {
      color: #64748b;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
    }

    .rfd-body {
      padding: 16px;
    }

    .rfd-message {
      margin: 0;
      color: #334155;
    }

    .rfd-error {
      color: #dc2626;
      background: #fef2f2;
      padding: 8px 12px;
      border-radius: 6px;
      border-left: 3px solid #fca5a5;
    }

    .rfd-result {
      border-left: 3px solid #94a3b8;
      padding-left: 12px;
      background: #f8fafc;
      padding: 12px;
      border-radius: 0 8px 8px 0;
    }

    .rfd-result-danger {
      border-left-color: #dc2626;
      background: #fef2f2;
    }

    .rfd-result-safe {
      border-left-color: #16a34a;
      background: #f0fdf4;
    }

    .rfd-result-title {
      font-weight: 700;
      font-size: 14px;
      margin: 0 0 4px;
    }

    .rfd-meta-container {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 0 0 8px;
    }

    .rfd-meta-risk {
      color: #64748b;
      font-size: 12px;
      font-weight: 600;
      text-transform: capitalize;
    }

    .rfd-confidence-chart-wrapper {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .rfd-confidence-chart {
      width: 14px;
      height: 14px;
      border-radius: 50%;
    }

    .rfd-meta-confidence {
      color: #64748b;
      font-size: 12px;
    }

    .rfd-actions,
    .rfd-inline-actions {
      align-items: center;
      display: flex;
      gap: 8px;
    }

    .rfd-actions {
      background: #f8fafc;
      border-top: 1px solid #e2e8f0;
      justify-content: flex-end;
      padding: 12px 16px;
    }

    .rfd-inline-actions {
      margin-top: 12px;
    }

    .rfd-button {
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
      min-height: 34px;
      padding: 0 14px;
      transition: all 0.2s ease;
    }

    .rfd-button:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.4);
      border-color: #dc2626;
    }

    .rfd-button:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    .rfd-button-primary {
      background: #dc2626;
      border-color: #dc2626;
      color: #ffffff;
      box-shadow: 0 1px 2px rgba(220, 38, 38, 0.2);
    }

    .rfd-button-primary:hover:not(:disabled) {
      background: #b91c1c;
      border-color: #b91c1c;
      transform: translateY(-1px);
      box-shadow: 0 4px 6px rgba(220, 38, 38, 0.25);
    }

    .rfd-button-primary:active:not(:disabled) {
      transform: translateY(0);
      box-shadow: 0 1px 2px rgba(220, 38, 38, 0.2);
    }

    .rfd-button-secondary {
      background: #ffffff;
      color: #1e293b;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    }

    .rfd-button-secondary:hover:not(:disabled) {
      background: #f4f6f8;
      border-color: #94a3b8;
    }

    .rfd-preview-list {
      margin: 12px 0 0;
      max-height: 180px;
      overflow-y: auto;
      padding-left: 0;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
    }

    .rfd-preview-list li {
      overflow-wrap: anywhere;
    }

    .rfd-preview-item {
      align-items: center;
      border-bottom: 1px solid #f1f5f9;
      display: grid;
      gap: 12px;
      grid-template-columns: 1fr auto;
      list-style-position: inside;
      padding: 8px 12px;
      background: #ffffff;
    }

    .rfd-preview-item:last-child {
      border-bottom: 0;
    }

    .rfd-preview-text {
      min-width: 0;
      line-height: 1.4;
    }

    .rfd-speaker {
      color: #64748b;
      font-weight: 700;
    }

    .rfd-button-quiet {
      background: transparent;
      border: none;
      color: #94a3b8;
      min-height: 24px;
      padding: 0;
      width: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      box-shadow: none;
    }

    .rfd-button-quiet:hover:not(:disabled) {
      background: #f1f5f9;
      color: #dc2626;
    }

    .rfd-remove-button {
      line-height: 1;
      font-size: 14px;
      font-weight: 700;
    }

    .rfd-title-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .rfd-spinner {
      width: 14px;
      height: 14px;
      margin-right: 6px;
      animation: rfd-spin 1s linear infinite;
    }

    @keyframes rfd-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
  return style;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error("Extension background is unavailable. Reload the page and try again."));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error?.message || "The detector could not complete the request."));
        return;
      }

      resolve(response.data);
    });
  });
}

function findConversationRoot(doc) {
  return (
    doc.querySelector('[role="main"]') ||
    doc.querySelector('[aria-label="Messages" i]') ||
    doc.body
  );
}

function inferConversationColumnRect(doc, root, rootRect) {
  const composer = findMessageComposer(doc, root);
  const composerRect = getUsableRect(composer);

  if (!hasUsableDimensions(composerRect)) {
    return rootRect;
  }

  const horizontalPadding = Math.max(96, composerRect.width * 0.2);
  const leftExpansion = Math.max(220, composerRect.width * 0.5);

  return {
    top: rootRect.top,
    left: Math.max(rootRect.left, composerRect.left - leftExpansion),
    right: Math.min(rectRight(rootRect), rectRight(composerRect) + horizontalPadding),
    bottom: Math.min(rectBottom(rootRect), rectBottom(composerRect) + 80),
  };
}

function findMessageComposer(doc, root) {
  const candidates = Array.from(
    root.querySelectorAll(
      '[role="textbox"][contenteditable="true"], [contenteditable="true"][aria-label], textarea[aria-label], input[aria-label]'
    )
  );
  const viewportHeight = doc.defaultView?.innerHeight ?? globalThis.innerHeight ?? 0;

  return candidates
    .map((element) => ({ element, rect: getUsableRect(element) }))
    .filter(({ rect }) => hasUsableDimensions(rect))
    .filter(({ rect }) => viewportHeight === 0 || rect.top > viewportHeight * 0.45)
    .sort((a, b) => rectBottom(b.rect) - rectBottom(a.rect))[0]?.element;
}

function isPotentialMessengerTextElement(element, text) {
  if (!(element instanceof Element)) {
    return false;
  }

  if (element.closest(`#${HOST_ID}, button, nav, header, [role="banner"], [role="textbox"], textarea, input, [contenteditable="true"]`)) {
    return false;
  }

  if (text.length === 0 || text.length > 800) {
    return false;
  }

  if (!isLeafReadableText(element, text)) {
    return false;
  }

  const rect = getUsableRect(element);
  if (rect.width < 8 || rect.height < 8) {
    return false;
  }

  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

export function filterMessengerTextItems(items, options = {}) {
  const blockedExactTexts = new Set(
    (options.blockedExactTexts ?? [])
      .map(normalizeDomText)
      .filter(Boolean)
      .map((text) => text.toLowerCase())
  );
  const sortedItems = items
    .map((item) => ({ ...item, text: normalizeDomText(item.text) }))
    .filter((item) => item.text)
    .filter((item) => !blockedExactTexts.has(item.text.toLowerCase()))
    .filter((item) => isTextItemInsideRect(item, options.conversationRect))
    .sort((a, b) => numberOrZero(a.top) - numberOrZero(b.top) || numberOrZero(a.left) - numberOrZero(b.left));
  const filteredItems = [];
  let pendingReplyContext = null;

  for (const item of sortedItems) {
    if (isLikelyMessengerMetadataText(item.text)) {
      if (isLikelyReplyContextText(item.text)) {
        pendingReplyContext = item;
      }
      continue;
    }

    if (item.element && isLikelyReplyPreviewElement(item.element, item.text)) {
      continue;
    }

    if (pendingReplyContext && isNearReplyContext(pendingReplyContext, item)) {
      pendingReplyContext = null;
      continue;
    }

    pendingReplyContext = null;
    filteredItems.push(item);
  }

  return filteredItems;
}

export function isLikelyMessengerMetadataText(text) {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const lower = normalized.toLowerCase();

  if (!lower) {
    return false;
  }

  if (EXACT_METADATA_TEXT.has(lower)) {
    return true;
  }

  if (URL_ONLY_PATTERN.test(normalized) && normalized.length > 48) {
    return true;
  }

  if (/^(?:sent|delivered|read|seen)(?:\s+by\s+.+|\s+\d+\s*(?:s|m|h|d|sec|secs|min|mins|hr|hrs|day|days)\s+ago)?$/iu.test(lower)) {
    return true;
  }

  if (/^active\s+(?:now|\d+\s*(?:s|m|h|d|sec|secs|min|mins|hr|hrs|day|days)\s+ago)$/iu.test(lower)) {
    return true;
  }

  if (isLikelyReplyContextText(normalized)) {
    return true;
  }

  return DATE_METADATA_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isLikelyReplyContextText(text) {
  const normalized = normalizeDomText(text);
  return REPLY_CONTEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isLikelyReplyPreviewText(text, nearbyTexts) {
  const normalizedText = normalizeDomText(text);
  const normalizedNearbyTexts = nearbyTexts.map(normalizeDomText).filter(Boolean);
  const replyLabelIndex = normalizedNearbyTexts.findIndex(isLikelyMessengerMetadataText);

  if (!normalizedText || replyLabelIndex < 0) {
    return false;
  }

  const meaningfulAfterLabel = normalizedNearbyTexts
    .slice(replyLabelIndex + 1)
    .filter((nearbyText) => !isLikelyMessengerMetadataText(nearbyText));

  return meaningfulAfterLabel.length > 1 && meaningfulAfterLabel[0] === normalizedText;
}

function isLikelyReplyPreviewElement(element, text) {
  let ancestor = element.parentElement;
  let depth = 0;

  while (ancestor && depth < 6 && !ancestor.matches('[role="main"], body')) {
    const nearbyTexts = getLeafAutoTexts(ancestor);
    if (nearbyTexts.length > 1 && isLikelyReplyPreviewText(text, nearbyTexts)) {
      return true;
    }

    ancestor = ancestor.parentElement;
    depth += 1;
  }

  return false;
}

function isLeafReadableText(element, text) {
  const descendants = Array.from(element.querySelectorAll("[dir='auto']"));
  return !descendants.some((child) => child !== element && normalizeDomText(child.textContent) === text);
}

function findConversationTitles(doc, root, rootRect) {
  const titleSelectors = [
    'header [dir="auto"]',
    '[role="banner"] [dir="auto"]',
    '[role="heading"] [dir="auto"]',
    "h1",
    "h2",
    "h3",
  ];

  const domTitles = Array.from(root.querySelectorAll(titleSelectors.join(",")))
    .map((element) => ({
      text: normalizeDomText(element.textContent),
      rect: getUsableRect(element),
    }))
    .filter(({ text }) => text.length >= 2 && text.length <= 80)
    .filter(({ text }) => !isLikelyMessengerMetadataText(text))
    .filter(({ text }) => !URL_ONLY_PATTERN.test(text))
    .filter(({ rect }) => numberOrZero(rect.top) <= numberOrZero(rootRect.top) + 140)
    .map(({ text }) => text);

  const titles = new Set(domTitles);

  if (doc && doc.title) {
    let docTitle = doc.title.replace(/\s*\|\s*Messenger\s*$/i, "").trim();
    docTitle = docTitle.replace(/^\(\d+\)\s*/, "").trim();
    if (docTitle.length >= 2) {
      titles.add(docTitle);
    }
  }

  return Array.from(titles);
}

function getLeafAutoTexts(element) {
  return Array.from(element.querySelectorAll("[dir='auto']"))
    .filter((child) => isLeafReadableText(child, normalizeDomText(child.textContent)))
    .map((child) => normalizeDomText(child.textContent))
    .filter(Boolean);
}

function normalizeDomText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNearReplyContext(replyContext, item) {
  const topGap = numberOrZero(item.top) - numberOrZero(replyContext.top);
  return topGap >= -4 && topGap <= 120;
}

function isTextItemInsideRect(item, rect) {
  if (!rect) {
    return true;
  }

  const centerX = numberOrZero(item.left) + numberOrZero(item.width) / 2;
  const centerY = numberOrZero(item.top) + numberOrZero(item.height) / 2;

  return centerX >= numberOrZero(rect.left) &&
    centerX <= rectRight(rect) &&
    centerY >= numberOrZero(rect.top) &&
    centerY <= rectBottom(rect);
}

function hasUsableDimensions(rect) {
  return numberOrZero(rect.width) > 8 && numberOrZero(rect.height) > 8;
}

function rectRight(rect) {
  return Number.isFinite(rect?.right) ? rect.right : numberOrZero(rect?.left) + numberOrZero(rect?.width);
}

function rectBottom(rect) {
  return Number.isFinite(rect?.bottom) ? rect.bottom : numberOrZero(rect?.top) + numberOrZero(rect?.height);
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function inferOutgoingMessage(element, rect, rootRect) {
  const labelledAncestor = element.closest("[aria-label]");
  const label = labelledAncestor?.getAttribute("aria-label")?.toLowerCase() ?? "";

  if (label.includes("you sent") || label.includes("sent by you") || label.includes("outgoing")) {
    return true;
  }

  if (label.includes("sent by") || label.includes("incoming")) {
    return false;
  }

  const midpoint = rootRect.left + rootRect.width / 2;
  return rect.left + rect.width / 2 >= midpoint;
}

function getUsableRect(element) {
  return element?.getBoundingClientRect?.() ?? { top: 0, left: 0, width: 0, height: 0 };
}
