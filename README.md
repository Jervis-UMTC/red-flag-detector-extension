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

## Privacy And Safety

This extension treats Messenger text as sensitive.

- Analysis is manual by default.
- The first scan asks for consent unless consent is already enabled in the popup.
- Raw message text is sent only to the configured API when Analyze is clicked.

- Raw message text is not persisted in Chrome storage.
- The service worker sends requests with `credentials: "omit"`.
- Results are advisory model output, not proof or professional advice.

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
