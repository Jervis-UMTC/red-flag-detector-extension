# PH Red Flag Detector for Messenger

Manifest V3 Chrome extension that adds a manual red-flag scan action to Facebook Messenger. It sends the latest visible text-message window to the PH Red Flag Detector API and shows an advisory result in Messenger.

## What It Does

- Runs on `messenger.com` and `facebook.com/messages`.
- Extracts the current visible conversation context, including while backreading.
- Normalizes speakers as `A` for the user and `B` for the other participant.
- Shows an interactive preview so messages can be included or skipped before sending.
- Retrieves a 5, 10, or 20 message context window for review, anchored on the current backread position.
- Sends the selected context window once to `/predict`; backend scanning/windowing is handled by the API.
- Shows label, confidence, risk level, and the API explanation.
- Shows formatter/window metadata when the API returns it.
- Stores settings only; raw chat messages are not saved.

## API

Default API base URL:

```text
https://jerbenjems-ph-redflag-detector-api.hf.space
```

The extension calls:

```text
GET /health
POST /predict
```

Custom API URLs must use HTTPS, except `localhost` and `127.0.0.1` for local development.

## Load In Chrome

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select this project folder.
6. Open Messenger and use the PH Red Flag Detector panel.

## Settings

Open the extension popup to configure:

- Enable or pause the Messenger overlay.
- Language mix.
- Context to scan.

- API base URL.
- Preview before sending.
- Manual-scan consent.

If a custom API host is configured, Chrome asks for host permission for that API origin.

## Privacy Policy

This extension treats all Messenger text as highly sensitive and complies with the **Philippine Data Privacy Act of 2012 (Republic Act No. 10173)**.

### Data Collection and Usage
- **What is collected:** Only the visible chat context (up to 20 messages) currently on your screen is extracted.
- **How it is used:** The text is temporarily sent to the configured API for the sole purpose of running the red-flag detection model.
- **Data Storage:** Raw message text is **never** saved to your local browser storage or persisted by the default API backend. It is processed in memory and immediately discarded after the prediction is returned.
- **Service Worker:** The extension sends network requests with `credentials: "omit"`, ensuring no cookies or session data are attached.

### User Consent
- **Mandatory Acceptance:** You must explicitly consent to the privacy policy upon opening the extension for the first time. The extension will remain disabled until consent is granted.
- **Manual Scanning:** Analysis is entirely manual. The extension only sends data when you explicitly click the "Analyze" button on a conversation window.

> **Disclaimer:** The results are advisory model outputs intended for personal guidance. They do not constitute proof of harm or professional legal/psychological advice.

## Development

Run tests:

```bash
npm.cmd test
```

Validate the extension manifest and source checks:

```bash
npm.cmd run build
```

Run both:

```bash
npm.cmd run validate
```

PowerShell may block `npm.ps1` on this machine, so `npm.cmd` is the safest command form.

## Known Limitations

- Messenger DOM markup changes frequently, so message extraction is heuristic.
- Group chat support is not specialized in v1.
- Attachment-only messages, images, stickers, and voice notes are ignored.
- Messenger may still limit older text if the conversation cannot scroll/load more messages in the page.
- The API is a prototype academic NLP backend, so predictions should be interpreted cautiously.
