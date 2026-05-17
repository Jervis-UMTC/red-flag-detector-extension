import {
  DEFAULT_RETRIEVAL_MESSAGE_COUNT,
  MESSAGE_TYPES,
  RISK_COPY,
  SUPPORTED_RETRIEVAL_MESSAGE_COUNTS,
} from "../shared/constants.js";
import { normalizeMessages, normalizeRetrievalMessageCount } from "../shared/normalization.js";
import { loadSettings, saveSettings } from "../shared/settings.js";

const HOST_ID = "ph-red-flag-detector-root";
const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_VISIBLE_CANDIDATES = 80;
const MAX_RETRIEVAL_SCROLL_ATTEMPTS = 6;
const RETRIEVAL_SCROLL_DELAY_MS = 450;
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

export function collectVisibleMessengerMessages(doc = document, options = {}) {
  const root = findConversationRoot(doc);
  const rootRect = getUsableRect(root);
  const conversationRect = inferConversationColumnRect(doc, root, rootRect);
  const conversationTitles = findConversationTitles(doc, root, rootRect);
  const mainTitle = conversationTitles.length > 0 ? conversationTitles[0] : "Other";
  const selectors = [
    '[role="main"] [dir="auto"]',
    '[role="main"] [role="row"]',
    '[role="main"] [aria-label*="sent" i]',
    '[aria-label="Messages" i] [dir="auto"]',
    '[aria-label="Messages" i] [role="row"]',
    '[aria-label*="message" i] [dir="auto"]',
    '[aria-label*="message" i] [role="row"]',
    '[data-testid*="message" i] [dir="auto"]',
    '[data-testid*="message" i]',
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

  const maxMessages = Math.min(normalizeRetrievalMessageCount(options.maxMessages), MAX_VISIBLE_CANDIDATES);
  return candidates.slice(-maxMessages);
}

export async function collectMessengerMessages(doc = document, options = {}) {
  const maxMessages = Math.min(normalizeRetrievalMessageCount(options.maxMessages), MAX_VISIBLE_CANDIDATES);
  const anchorMessages = collectVisibleMessengerMessages(doc, { maxMessages });
  let messages = anchorMessages;

  if (messages.length >= maxMessages) {
    return messages;
  }

  const root = findConversationRoot(doc);
  const scroller = findConversationScroller(doc, root);
  const scrollState = getScrollState(scroller, doc);

  if (!scroller || !canScrollUp(scroller, doc)) {
    return messages;
  }

  const maxAttempts = Math.max(1, options.scrollAttempts ?? MAX_RETRIEVAL_SCROLL_ATTEMPTS);

  try {
    messages = await collectOlderContextMessages(doc, scroller, messages, maxMessages, maxAttempts, options);
    restoreScrollState(scrollState, doc);

    if (messages.length < maxMessages && canScrollDown(scroller, doc)) {
      messages = await collectNewerContextMessages(doc, scroller, messages, maxMessages, maxAttempts, options);
    }
  } finally {
    restoreScrollState(scrollState, doc);
  }

  return buildAnchoredContextWindow(messages, anchorMessages, maxMessages);
}

async function collectOlderContextMessages(doc, scroller, initialMessages, maxMessages, maxAttempts, options = {}) {
  let messages = initialMessages;

  for (let attempt = 0; attempt < maxAttempts && messages.length < maxMessages; attempt += 1) {
    const previousPosition = getScrollPosition(scroller, doc);
    scrollConversationUp(scroller, doc);
    await sleep(options.scrollDelayMs ?? RETRIEVAL_SCROLL_DELAY_MS);

    const nextPosition = getScrollPosition(scroller, doc);
    const olderMessages = collectVisibleMessengerMessages(doc, { maxMessages });
    messages = mergeOlderMessageSnapshot(messages, olderMessages);

    if (nextPosition <= 0 || Math.abs(previousPosition - nextPosition) < 2) {
      break;
    }
  }

  return messages;
}

async function collectNewerContextMessages(doc, scroller, initialMessages, maxMessages, maxAttempts, options = {}) {
  let messages = initialMessages;

  for (let attempt = 0; attempt < maxAttempts && messages.length < maxMessages; attempt += 1) {
    const previousPosition = getScrollPosition(scroller, doc);
    scrollConversationDown(scroller, doc);
    await sleep(options.scrollDelayMs ?? RETRIEVAL_SCROLL_DELAY_MS);

    const nextPosition = getScrollPosition(scroller, doc);
    const newerMessages = collectVisibleMessengerMessages(doc, { maxMessages });
    messages = mergeNewerMessageSnapshot(messages, newerMessages);

    if (isNearScrollBottom(scroller, doc) || Math.abs(previousPosition - nextPosition) < 2) {
      break;
    }
  }

  return messages;
}

export function mergeOlderMessageSnapshot(existingMessages, olderVisibleMessages) {
  const existing = Array.isArray(existingMessages) ? existingMessages : [];
  const older = Array.isArray(olderVisibleMessages) ? olderVisibleMessages : [];

  if (existing.length === 0) {
    return older;
  }

  if (older.length === 0) {
    return existing;
  }

  const overlap = countOrderedMessageOverlap(older, existing);
  return [...older, ...existing.slice(overlap)];
}

export function mergeNewerMessageSnapshot(existingMessages, newerVisibleMessages) {
  const existing = Array.isArray(existingMessages) ? existingMessages : [];
  const newer = Array.isArray(newerVisibleMessages) ? newerVisibleMessages : [];

  if (existing.length === 0) {
    return newer;
  }

  if (newer.length === 0) {
    return existing;
  }

  const overlap = countOrderedMessageOverlap(existing, newer);
  return [...existing, ...newer.slice(overlap)];
}

export function buildAnchoredContextWindow(messages, anchorMessages, maxMessages) {
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  const normalizedAnchor = Array.isArray(anchorMessages) ? anchorMessages : [];
  const maxCount = Math.max(1, Number.isInteger(maxMessages) ? maxMessages : DEFAULT_RETRIEVAL_MESSAGE_COUNT);

  if (normalizedMessages.length <= maxCount) {
    return normalizedMessages;
  }

  if (normalizedAnchor.length === 0) {
    return normalizedMessages.slice(-maxCount);
  }

  const anchorRange = findAnchorRange(normalizedMessages, normalizedAnchor);
  if (!anchorRange) {
    return normalizedMessages.slice(-maxCount);
  }

  const anchorLength = anchorRange.end - anchorRange.start;
  if (anchorLength >= maxCount) {
    return normalizedMessages.slice(anchorRange.end - maxCount, anchorRange.end);
  }

  const extraCount = maxCount - anchorLength;
  const preferredBefore = Math.ceil(extraCount / 2);
  const beforeCount = Math.min(anchorRange.start, preferredBefore);
  const afterCount = Math.min(normalizedMessages.length - anchorRange.end, extraCount - beforeCount);
  const remainingBeforeCount = Math.min(anchorRange.start - beforeCount, extraCount - beforeCount - afterCount);
  const start = anchorRange.start - beforeCount - remainingBeforeCount;

  return normalizedMessages.slice(start, start + maxCount);
}

export function countOrderedMessageOverlap(leftMessages, rightMessages) {
  const maxOverlap = Math.min(leftMessages.length, rightMessages.length);

  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const leftStart = leftMessages.length - overlap;
    const matches = leftMessages
      .slice(leftStart)
      .every((message, index) => previewMessageKey(message) === previewMessageKey(rightMessages[index]));

    if (matches) {
      return overlap;
    }
  }

  return 0;
}

function findAnchorRange(messages, anchorMessages) {
  const anchorKeys = anchorMessages.map(previewMessageKey);

  for (let start = 0; start <= messages.length - anchorKeys.length; start += 1) {
    const matches = anchorKeys.every((key, index) => previewMessageKey(messages[start + index]) === key);
    if (matches) {
      return { start, end: start + anchorKeys.length };
    }
  }

  return null;
}

export function createPreviewSelectionIndexes(messages) {
  return Array.isArray(messages) ? messages.map((_message, index) => index) : [];
}

export function getSelectedPreviewMessages(messages, selectedIndexes) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return normalizePreviewSelectionIndexes(selectedIndexes, messages.length)
    .map((index) => messages[index])
    .filter(Boolean);
}

export function togglePreviewSelectionIndex(selectedIndexes, index, totalCount) {
  const normalizedIndexes = normalizePreviewSelectionIndexes(selectedIndexes, totalCount);
  if (!Number.isInteger(index) || index < 0 || index >= totalCount) {
    return normalizedIndexes;
  }

  if (normalizedIndexes.includes(index)) {
    return normalizedIndexes.filter((selectedIndex) => selectedIndex !== index);
  }

  return normalizePreviewSelectionIndexes([...normalizedIndexes, index], totalCount);
}

function normalizePreviewSelectionIndexes(selectedIndexes, totalCount) {
  const maxIndex = Math.max(0, Number.isInteger(totalCount) ? totalCount : 0);
  return Array.from(new Set(Array.isArray(selectedIndexes) ? selectedIndexes : []))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < maxIndex)
    .sort((a, b) => a - b);
}

function previewMessageKey(message) {
  const speaker = String(message?.speaker ?? "").trim().toLowerCase();
  const text = String(message?.text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const outgoing = message?.isOutgoing === true ? "out" : "in";
  return `${speaker}:${outgoing}:${text}`;
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
      previewSelectedIndexes: [],
      previewExpanded: false,
      retrievalMessageCount: DEFAULT_RETRIEVAL_MESSAGE_COUNT,
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

    try {
      const settings = await loadSettings();
      this.state.retrievalMessageCount = settings.messageRetrievalCount;
      if (!settings.consentAccepted) {
        this.state.awaitingConsent = true;
        this.state.status = "Consent";
      }
    } catch {
      this.state.retrievalMessageCount = DEFAULT_RETRIEVAL_MESSAGE_COUNT;
    }

    this.render();
  }

  render() {
    this.container.replaceChildren();

    const header = document.createElement("header");
    header.className = "rfd-header";
    const titleContainer = document.createElement("div");
    titleContainer.className = "rfd-title-group";
    titleContainer.append(createFlagIcon(), createTextElement("strong", "PH Red Flag Detector"));
    header.append(titleContainer);
    
    const headerRight = document.createElement("div");
    headerRight.style.display = "flex";
    headerRight.style.alignItems = "center";
    headerRight.style.gap = "8px";
    
    const statusText = createTextElement("span", this.state.status, "rfd-status");
    
    const collapseBtn = document.createElement("button");
    collapseBtn.className = "rfd-button-quiet";
    collapseBtn.setAttribute("aria-label", this.state.collapsed ? "Expand panel" : "Collapse panel");
    collapseBtn.append(createChevronIcon(this.state.collapsed ? "up" : "down"));
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
      const selectedMessages = getSelectedPreviewMessages(this.state.previewMessages, this.state.previewSelectedIndexes);
      body.append(createPreviewView(
        this.state.previewMessages,
        this.state.previewSelectedIndexes,
        () => this.sendMessages(selectedMessages),
        () => this.cancelPendingFlow(),
        (index) => this.togglePreviewMessage(index),
        {
          expanded: this.state.previewExpanded,
          onToggleExpanded: () => this.togglePreviewExpanded(),
          onSelectAll: () => this.selectAllPreviewMessages(),
          onClearSelection: () => this.clearPreviewSelection(),
        }
      ));
    } else {
      const message = createTextElement("p", "Manual scan only. Visible messages are sent only after you click analyze.", "rfd-message");
      body.append(
        message,
        createRetrievalCountControl(
          this.state.retrievalMessageCount,
          (count) => this.updateRetrievalMessageCount(count)
        )
      );
    }

    const actions = document.createElement("footer");
    actions.className = "rfd-actions";

    const analyzeButton = createButton("", "primary", () => this.startAnalysis());
    if (this.state.busy) {
      analyzeButton.replaceChildren(createSpinnerIcon(), document.createTextNode("Checking..."));
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
    this.setState({ busy: true, status: "Reading", error: "", result: null, previewMessages: null, previewSelectedIndexes: [], previewExpanded: false });

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

      const messageRetrievalCount = normalizeRetrievalMessageCount(this.state.retrievalMessageCount);
      const messages = await collectMessengerMessages(document, { maxMessages: messageRetrievalCount });
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
        this.setState({
          busy: false,
          status: "Preview",
          previewMessages: messages,
          previewSelectedIndexes: createPreviewSelectionIndexes(messages),
        });
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
    
    if (!this.pendingMessages) {
      // User accepted before clicking analyze, just show the normal view.
      this.setState({ awaitingConsent: false, status: "Ready" });
      return;
    }

    const messages = this.pendingMessages;
    this.pendingMessages = null;

    if (settings.showPreviewBeforeSending) {
      this.setState({
        awaitingConsent: false,
        status: "Preview",
        previewMessages: messages,
        previewSelectedIndexes: createPreviewSelectionIndexes(messages),
      });
      return;
    }

    await this.sendMessages(messages);
  }

  async sendMessages(messages) {
    this.setState({ busy: true, status: "Checking", error: "", result: null, previewMessages: null, previewSelectedIndexes: [], previewExpanded: false, awaitingConsent: false });

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

  async cancelPendingFlow() {
    this.pendingMessages = null;
    let consentAccepted = false;
    try {
      const settings = await loadSettings();
      consentAccepted = settings.consentAccepted;
    } catch {
      consentAccepted = false;
    }

    this.setState({
      busy: false,
      status: consentAccepted ? "Ready" : "Consent",
      awaitingConsent: !consentAccepted,
      previewMessages: null,
      previewSelectedIndexes: [],
      previewExpanded: false,
      error: "",
    });
  }

  resetResult() {
    this.setState({ status: "Ready", result: null, error: "", previewSelectedIndexes: [], previewExpanded: false });
  }

  togglePreviewMessage(index) {
    const previewMessages = this.state.previewMessages ?? [];
    const previewSelectedIndexes = togglePreviewSelectionIndex(
      this.state.previewSelectedIndexes,
      index,
      previewMessages.length
    );

    this.setState({
      status: previewMessages.length > 0 ? "Preview" : "No messages",
      previewSelectedIndexes,
    });
  }

  selectAllPreviewMessages() {
    const previewMessages = this.state.previewMessages ?? [];
    this.setState({
      status: previewMessages.length > 0 ? "Preview" : "No messages",
      previewSelectedIndexes: createPreviewSelectionIndexes(previewMessages),
    });
  }

  clearPreviewSelection() {
    this.setState({ previewSelectedIndexes: [] });
  }

  async updateRetrievalMessageCount(value) {
    const retrievalMessageCount = normalizeRetrievalMessageCount(value);
    this.setState({ retrievalMessageCount });

    try {
      const settings = await loadSettings();
      await saveSettings({ ...settings, messageRetrievalCount });
    } catch {
      // The in-panel state still applies to the current scan if storage is unavailable.
    }
  }

  togglePreviewExpanded() {
    this.setState({ previewExpanded: !this.state.previewExpanded });
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
  
  wrapper.append(createTextElement("p", "Before using the Red Flag Detector, please review and accept our Privacy Policy (available in the extension popup).", "rfd-message"));
  
  const privacyNote = document.createElement("p");
  privacyNote.className = "rfd-message";
  privacyNote.style.fontSize = "12px";
  privacyNote.style.color = "var(--muted)";
  
  const strongText = document.createElement("strong");
  strongText.textContent = "only";
  
  privacyNote.append(
    document.createTextNode("We process your chat context locally and through our API "),
    strongText,
    document.createTextNode(" when you click 'Analyze'. We do not store your data.")
  );
  
  wrapper.append(privacyNote);

  const actions = document.createElement("div");
  actions.className = "rfd-inline-actions";
  actions.append(createButton("Accept & Continue", "primary", onContinue));
  actions.append(createButton("Cancel", "secondary", onCancel));
  wrapper.append(actions);

  return wrapper;
}

function createRetrievalCountControl(selectedCount, onChange) {
  const wrapper = document.createElement("label");
  wrapper.className = "rfd-count-field";

  const labelText = createTextElement("span", "Context to scan", "rfd-count-label");
  const select = document.createElement("select");
  select.className = "rfd-count-select";
  select.setAttribute("aria-label", "Context messages to scan");

  for (const count of SUPPORTED_RETRIEVAL_MESSAGE_COUNTS) {
    const option = document.createElement("option");
    option.value = String(count);
    option.textContent = `Context ${count}`;
    select.append(option);
  }

  select.value = String(normalizeRetrievalMessageCount(selectedCount));
  select.addEventListener("change", () => onChange(select.value));
  wrapper.append(labelText, select);
  return wrapper;
}

function createPreviewView(messages, selectedIndexes, onContinue, onCancel, onToggleMessage, options = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = `rfd-preview${options.expanded ? " rfd-preview-expanded" : ""}`;
  const selectedIndexSet = new Set(normalizePreviewSelectionIndexes(selectedIndexes, messages.length));
  const selectedCount = selectedIndexSet.size;

  const header = document.createElement("div");
  header.className = "rfd-preview-header";
  const titleGroup = document.createElement("div");
  titleGroup.className = "rfd-preview-title-group";
  titleGroup.append(
    createTextElement("p", "Review messages", "rfd-result-title"),
    createTextElement("span", `${selectedCount} of ${messages.length} selected`, "rfd-preview-count")
  );
  header.append(titleGroup);

  if (messages.length > 0) {
    const headerActions = document.createElement("div");
    headerActions.className = "rfd-preview-header-actions";
    headerActions.append(createButton(selectedCount === messages.length ? "Clear selection" : "Select all", "secondary", (selectedCount === messages.length ? options.onClearSelection : options.onSelectAll) ?? (() => {}), {
      className: "rfd-preview-toggle",
    }));
    headerActions.append(createButton(options.expanded ? "Compact view" : "Larger view", "secondary", options.onToggleExpanded ?? (() => {}), {
      className: "rfd-preview-toggle",
      ariaLabel: options.expanded ? "Use compact preview" : "Use larger preview",
      icon: options.expanded ? createShrinkIcon() : createExpandIcon(),
    }));
    header.append(headerActions);
  }

  wrapper.append(header);

  const list = document.createElement("ol");
  list.className = "rfd-preview-list";

  if (messages.length === 0) {
    wrapper.append(createTextElement("p", "No messages selected.", "rfd-message"));
  }

  for (const [index, message] of messages.entries()) {
    const selected = selectedIndexSet.has(index);
    const item = document.createElement("li");
    item.className = `rfd-preview-item${selected ? " rfd-preview-item-selected" : ""}`;

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "rfd-preview-choice";
    toggleButton.setAttribute("role", "checkbox");
    toggleButton.setAttribute("aria-checked", String(selected));
    toggleButton.setAttribute("aria-label", `${selected ? "Exclude" : "Include"} message ${index + 1} from ${message.speaker}`);
    toggleButton.addEventListener("click", () => onToggleMessage(index));

    const selectionIcon = document.createElement("span");
    selectionIcon.className = "rfd-preview-check";
    selectionIcon.append(selected ? createCheckIcon() : createPlusIcon());

    const messageIndex = createTextElement("span", String(index + 1), "rfd-preview-index");
    messageIndex.setAttribute("aria-hidden", "true");

    const messageBody = document.createElement("span");
    messageBody.className = "rfd-preview-text";
    messageBody.append(createTextElement("span", message.speaker, "rfd-speaker"));
    messageBody.append(document.createTextNode(message.text));

    const stateText = createTextElement("span", selected ? "Included" : "Skipped", "rfd-preview-state");

    toggleButton.append(selectionIcon, messageIndex, messageBody, stateText);
    item.append(toggleButton);
    list.append(item);
  }

  const actions = document.createElement("div");
  actions.className = "rfd-inline-actions";
  actions.append(createButton("Send", "primary", onContinue, { disabled: selectedCount === 0 }));
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
  if (options.icon) {
    button.append(options.icon);
  }
  if (label) {
    button.append(document.createTextNode(label));
  }
  if (options.ariaLabel) {
    button.setAttribute("aria-label", options.ariaLabel);
  }
  button.disabled = options.disabled === true;
  button.addEventListener("click", onClick ?? (() => {}));
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

function createFlagIcon() {
  const svg = createSvgElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "#dc2626",
    "stroke-width": "2.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svg.append(
    createSvgElement("path", { d: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" }),
    createSvgElement("line", { x1: "4", y1: "22", x2: "4", y2: "15" })
  );
  return svg;
}

function createChevronIcon(direction) {
  const svg = createSvgElement("svg", {
    width: "18",
    height: "18",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svg.append(createSvgElement("polyline", {
    points: direction === "up" ? "18 15 12 9 6 15" : "6 9 12 15 18 9",
  }));
  return svg;
}

function createSpinnerIcon() {
  const svg = createSvgElement("svg", {
    class: "rfd-spinner",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "3",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  svg.append(createSvgElement("path", { d: "M21 12a9 9 0 1 1-6.219-8.56" }));
  return svg;
}

function createExpandIcon() {
  const svg = createPreviewToolIcon();
  svg.append(
    createSvgElement("polyline", { points: "15 3 21 3 21 9" }),
    createSvgElement("polyline", { points: "9 21 3 21 3 15" }),
    createSvgElement("line", { x1: "21", y1: "3", x2: "14", y2: "10" }),
    createSvgElement("line", { x1: "3", y1: "21", x2: "10", y2: "14" })
  );
  return svg;
}

function createShrinkIcon() {
  const svg = createPreviewToolIcon();
  svg.append(
    createSvgElement("polyline", { points: "14 10 20 10 20 4" }),
    createSvgElement("polyline", { points: "10 14 4 14 4 20" }),
    createSvgElement("line", { x1: "20", y1: "10", x2: "13", y2: "3" }),
    createSvgElement("line", { x1: "4", y1: "14", x2: "11", y2: "21" })
  );
  return svg;
}

function createCheckIcon() {
  const svg = createPreviewToolIcon();
  svg.append(
    createSvgElement("polyline", { points: "20 6 9 17 4 12" })
  );
  return svg;
}

function createPlusIcon() {
  const svg = createPreviewToolIcon();
  svg.append(
    createSvgElement("line", { x1: "12", y1: "5", x2: "12", y2: "19" }),
    createSvgElement("line", { x1: "5", y1: "12", x2: "19", y2: "12" })
  );
  return svg;
}

function createPreviewToolIcon() {
  return createSvgElement("svg", {
    class: "rfd-button-icon",
    width: "14",
    height: "14",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  });
}

function createSvgElement(tagName, attributes) {
  const element = document.createElementNS(SVG_NS, tagName);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
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

    .rfd-count-field {
      align-items: center;
      display: grid;
      gap: 8px;
      grid-template-columns: minmax(0, 1fr) auto;
      margin-top: 12px;
    }

    .rfd-count-label {
      color: #475569;
      font-weight: 700;
      min-width: 0;
    }

    .rfd-count-select {
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      color: #1e293b;
      font: inherit;
      min-height: 34px;
      padding: 0 10px;
    }

    .rfd-count-select:focus-visible {
      outline: none;
      border-color: #dc2626;
      box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.4);
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
      align-items: center;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      font-weight: 600;
      gap: 6px;
      justify-content: center;
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

    .rfd-button-icon {
      flex: 0 0 auto;
    }

    .rfd-preview-header {
      align-items: flex-start;
      display: flex;
      gap: 12px;
      justify-content: space-between;
    }

    .rfd-preview-header-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
    }

    .rfd-preview-title-group {
      min-width: 0;
    }

    .rfd-preview-count {
      color: #64748b;
      display: block;
      font-size: 12px;
      line-height: 1.3;
      margin-top: 2px;
    }

    .rfd-preview-toggle {
      flex: 0 0 auto;
      min-height: 30px;
      padding: 0 10px;
      white-space: nowrap;
    }

    .rfd-preview-list {
      margin: 12px 0 0;
      max-height: min(220px, calc(100vh - 300px));
      overflow-y: auto;
      padding-left: 0;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      background: #ffffff;
      scrollbar-gutter: stable;
    }

    .rfd-preview-expanded .rfd-preview-list {
      max-height: min(460px, calc(100vh - 220px));
    }

    .rfd-preview-list li {
      overflow-wrap: anywhere;
    }

    .rfd-preview-item {
      border-bottom: 1px solid #f1f5f9;
      list-style: none;
      background: #ffffff;
    }

    .rfd-preview-item:nth-child(even) .rfd-preview-choice {
      background: #f8fafc;
    }

    .rfd-preview-item:last-child {
      border-bottom: 0;
    }

    .rfd-preview-choice {
      align-items: flex-start;
      background: transparent;
      border: 0;
      color: #1e293b;
      cursor: pointer;
      display: grid;
      font: inherit;
      gap: 10px;
      grid-template-columns: 22px 24px minmax(0, 1fr) auto;
      line-height: inherit;
      padding: 10px 12px;
      text-align: left;
      width: 100%;
    }

    .rfd-preview-choice:hover {
      background: #f8fafc;
    }

    .rfd-preview-choice:focus-visible {
      outline: none;
      box-shadow: inset 0 0 0 2px rgba(220, 38, 38, 0.45);
    }

    .rfd-preview-check {
      align-items: center;
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      color: #64748b;
      display: inline-flex;
      height: 22px;
      justify-content: center;
      margin-top: 1px;
      width: 22px;
    }

    .rfd-preview-item-selected .rfd-preview-check {
      background: #fef2f2;
      border-color: #fecaca;
      color: #dc2626;
    }

    .rfd-preview-index {
      align-items: center;
      align-self: flex-start;
      background: #f1f5f9;
      border-radius: 999px;
      color: #64748b;
      display: inline-flex;
      font-size: 11px;
      font-weight: 700;
      height: 22px;
      justify-content: center;
      line-height: 1;
      margin-top: 1px;
      min-width: 22px;
      padding: 0 6px;
    }

    .rfd-preview-text {
      display: grid;
      gap: 3px;
      min-width: 0;
      line-height: 1.45;
    }

    .rfd-preview-item:not(.rfd-preview-item-selected) .rfd-preview-text {
      color: #64748b;
    }

    .rfd-speaker {
      color: #64748b;
      display: block;
      font-size: 11px;
      font-weight: 700;
      line-height: 1.2;
    }

    .rfd-preview-state {
      align-self: flex-start;
      border: 1px solid #e2e8f0;
      border-radius: 999px;
      color: #64748b;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      margin-top: 1px;
      padding: 5px 8px;
      white-space: nowrap;
    }

    .rfd-preview-item-selected .rfd-preview-state {
      background: #fef2f2;
      border-color: #fecaca;
      color: #b91c1c;
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

function findConversationScroller(doc, root) {
  const candidates = [
    root,
    ...Array.from(root?.querySelectorAll?.("*") ?? []),
    doc.scrollingElement,
    doc.documentElement,
  ];
  const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));

  return uniqueCandidates
    .map((element) => ({ element, rect: getUsableRect(element), score: scoreScrollerCandidate(element, doc) }))
    .filter(({ element, score }) => score > 0 && canScrollUp(element, doc))
    .sort((a, b) => b.score - a.score || numberOrZero(b.rect.height) - numberOrZero(a.rect.height))[0]?.element;
}

function scoreScrollerCandidate(element, doc) {
  if (!(element instanceof Element)) {
    return 0;
  }

  const rect = getUsableRect(element);
  const scrollHeight = numberOrZero(element.scrollHeight);
  const clientHeight = numberOrZero(element.clientHeight);
  const overflowY = getComputedStyle(element).overflowY;
  const canScrollVertically = scrollHeight > clientHeight + 40;
  const allowsScroll = /auto|scroll|overlay/i.test(overflowY) ||
    numberOrZero(element.scrollTop) > 0 ||
    element === doc.scrollingElement ||
    element === doc.documentElement;

  if (!canScrollVertically || !allowsScroll || rect.height < 120 || rect.width < 220) {
    return 0;
  }

  const textDensity = element.querySelectorAll?.('[dir="auto"], [role="row"], [aria-label*="sent" i]').length ?? 0;
  const composer = findMessageComposer(doc, element);
  const containsComposer = Boolean(composer);
  const areaScore = Math.min(200, (rect.width * rect.height) / 4000);

  return textDensity * 8 + areaScore - (containsComposer ? 30 : 0);
}

function getScrollState(scroller, doc) {
  if (!scroller) {
    return null;
  }

  return {
    scroller,
    top: getScrollPosition(scroller, doc),
  };
}

function restoreScrollState(scrollState, doc) {
  if (!scrollState?.scroller) {
    return;
  }

  setScrollPosition(scrollState.scroller, doc, scrollState.top);
}

function canScrollUp(scroller, doc) {
  return getScrollPosition(scroller, doc) > 2;
}

function canScrollDown(scroller, doc) {
  return !isNearScrollBottom(scroller, doc);
}

function scrollConversationUp(scroller, doc) {
  const currentPosition = getScrollPosition(scroller, doc);
  const viewportHeight = numberOrZero(scroller?.clientHeight) || doc.defaultView?.innerHeight || 600;
  const offset = Math.max(280, viewportHeight * 0.85);
  setScrollPosition(scroller, doc, Math.max(0, currentPosition - offset));
}

function scrollConversationDown(scroller, doc) {
  const currentPosition = getScrollPosition(scroller, doc);
  const viewportHeight = numberOrZero(scroller?.clientHeight) || doc.defaultView?.innerHeight || 600;
  const offset = Math.max(280, viewportHeight * 0.85);
  setScrollPosition(scroller, doc, Math.min(getMaxScrollTop(scroller, doc), currentPosition + offset));
}

function isNearScrollBottom(scroller, doc) {
  return getMaxScrollTop(scroller, doc) - getScrollPosition(scroller, doc) <= 2;
}

function getMaxScrollTop(scroller, doc) {
  if (scroller === doc.scrollingElement || scroller === doc.documentElement || scroller === doc.body) {
    const body = doc.body;
    const documentElement = doc.documentElement;
    const scrollHeight = Math.max(numberOrZero(body?.scrollHeight), numberOrZero(documentElement?.scrollHeight));
    const viewportHeight = doc.defaultView?.innerHeight ?? numberOrZero(documentElement?.clientHeight);
    return Math.max(0, scrollHeight - viewportHeight);
  }

  return Math.max(0, numberOrZero(scroller?.scrollHeight) - numberOrZero(scroller?.clientHeight));
}

function getScrollPosition(scroller, doc) {
  if (scroller === doc.scrollingElement || scroller === doc.documentElement || scroller === doc.body) {
    return doc.defaultView?.scrollY ?? numberOrZero(scroller?.scrollTop);
  }

  return numberOrZero(scroller?.scrollTop);
}

function setScrollPosition(scroller, doc, top) {
  const nextTop = Math.max(0, numberOrZero(top));

  if (scroller === doc.scrollingElement || scroller === doc.documentElement || scroller === doc.body) {
    doc.defaultView?.scrollTo?.({ top: nextTop, behavior: "auto" });
    if (scroller) {
      scroller.scrollTop = nextTop;
    }
    return;
  }

  scroller.scrollTop = nextTop;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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

  if (!element.matches('[dir="auto"]') && getLeafAutoTexts(element).length > 1) {
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
  const dedupedItems = dedupeMessengerTextItems(sortedItems);
  const filteredItems = [];
  let pendingReplyContext = null;

  for (const item of dedupedItems) {
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

export function dedupeMessengerTextItems(items) {
  const keptItems = [];

  for (const item of items) {
    if (keptItems.some((keptItem) => isDuplicateTextItem(keptItem, item))) {
      continue;
    }

    keptItems.push(item);
  }

  return keptItems;
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

function isDuplicateTextItem(first, second) {
  if (normalizeDomText(first.text).toLowerCase() !== normalizeDomText(second.text).toLowerCase()) {
    return false;
  }

  if (Boolean(first.isOutgoing) !== Boolean(second.isOutgoing)) {
    return false;
  }

  const topGap = Math.abs(numberOrZero(first.top) - numberOrZero(second.top));
  const leftGap = Math.abs(numberOrZero(first.left) - numberOrZero(second.left));
  const verticalTolerance = Math.max(20, Math.min(48, Math.max(numberOrZero(first.height), numberOrZero(second.height))));

  if (topGap > verticalTolerance) {
    return false;
  }

  return leftGap <= 28 || rectsOverlap(first, second);
}

function rectsOverlap(first, second) {
  const firstLeft = numberOrZero(first.left);
  const firstRight = rectRight(first);
  const firstTop = numberOrZero(first.top);
  const firstBottom = rectBottom(first);
  const secondLeft = numberOrZero(second.left);
  const secondRight = rectRight(second);
  const secondTop = numberOrZero(second.top);
  const secondBottom = rectBottom(second);

  return firstLeft <= secondRight &&
    firstRight >= secondLeft &&
    firstTop <= secondBottom &&
    firstBottom >= secondTop;
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
