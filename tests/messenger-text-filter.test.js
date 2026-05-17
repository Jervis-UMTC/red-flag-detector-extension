import test from "node:test";
import assert from "node:assert/strict";

import {
  filterMessengerTextItems,
  isLikelyMessengerMetadataText,
  isLikelyReplyPreviewText,
} from "../src/content/messenger-controller.js";

test("isLikelyMessengerMetadataText rejects Messenger timestamp-only text", () => {
  const metadataText = [
    "10:24 AM",
    "8:03 pm",
    "Yesterday at 11:58 PM",
    "Today at 7:01 AM",
    "Thu 8:31 PM",
    "Thursday at 8:31 PM",
    "May 14 at 8:03 AM",
    "May 14, 2026 at 8:03 AM",
    "05/14/2026, 8:03 AM",
  ];

  for (const text of metadataText) {
    assert.equal(isLikelyMessengerMetadataText(text), true, text);
  }
});

test("isLikelyMessengerMetadataText rejects Messenger delivery and read status text", () => {
  const metadataText = [
    "Sent",
    "Sent 14m ago",
    "Sent 15 mins ago",
    "Delivered",
    "Delivered 1h ago",
    "Seen",
    "Seen by Maria",
    "Read 2 days ago",
    "Active now",
    "Active 4h ago",
    "Typing...",
    "You",
  ];

  for (const text of metadataText) {
    assert.equal(isLikelyMessengerMetadataText(text), true, text);
  }
});

test("isLikelyMessengerMetadataText rejects long standalone pinned URLs", () => {
  assert.equal(
    isLikelyMessengerMetadataText("https://netflix.com/?nftoken=BgjXuOvcAxLCAaXD0dSp5eQVRjwA7I0dP"),
    true
  );
  assert.equal(isLikelyMessengerMetadataText("check this https://example.test later"), false);
});

test("isLikelyMessengerMetadataText rejects Messenger reply context labels", () => {
  const metadataText = [
    "You replied to John Marc",
    "You replied to yourself",
    "John Marc replied to you",
    "Maria replied to John Marc",
    "Replying to John Marc",
  ];

  for (const text of metadataText) {
    assert.equal(isLikelyMessengerMetadataText(text), true, text);
  }
});

test("isLikelyMessengerMetadataText keeps normal messages that mention time", () => {
  const messageText = [
    "See you at 8:30 PM",
    "Naa ko sa school.",
    "Send location bi.",
    "May 14 works for me",
    "Delivered na ba ang food?",
    "I replied to John Marc after class.",
  ];

  for (const text of messageText) {
    assert.equal(isLikelyMessengerMetadataText(text), false, text);
  }
});

test("isLikelyReplyPreviewText ignores the quoted preview line before the actual reply", () => {
  const nearbyTexts = [
    "You replied to John Marc",
    "Gitanggal nko ako oi hahahaha sayang",
    "gagoo",
  ];

  assert.equal(
    isLikelyReplyPreviewText("Gitanggal nko ako oi hahahaha sayang", nearbyTexts),
    true
  );
  assert.equal(isLikelyReplyPreviewText("gagoo", nearbyTexts), false);
});

test("filterMessengerTextItems drops reply labels and quoted bubbles from the visible Messenger stream", () => {
  const filtered = filterMessengerTextItems([
    item("Tue 17:35", 20, 320, false),
    item("Gitanggal nko ako oi hahahaha sayang", 110, 68, false),
    item("You replied to John Marc", 150, 500, true),
    item("Gitanggal nko ako oi hahahaha sayang", 178, 420, true),
    item("gagoo", 210, 594, true),
    item("kailangan man tu kay daghan kaaug missing values", 260, 296, true),
    item("Gani hahaha", 335, 68, false),
  ]);

  assert.deepEqual(
    filtered.map((message) => ({ text: message.text, isOutgoing: message.isOutgoing })),
    [
      { text: "Gitanggal nko ako oi hahahaha sayang", isOutgoing: false },
      { text: "gagoo", isOutgoing: true },
      { text: "kailangan man tu kay daghan kaaug missing values", isOutgoing: true },
      { text: "Gani hahaha", isOutgoing: false },
    ]
  );
});

test("filterMessengerTextItems ignores the right conversation details panel", () => {
  const filtered = filterMessengerTextItems(
    [
      item("Media and files", 398, 728, true),
      item("Gitanggal nko ako oi hahahaha sayang", 426, 80, false),
      item("Privacy & support", 454, 728, true),
      item("gagoo", 482, 606, true),
      item("kailangan man tu kay daghan kaaug missing values", 522, 310, true),
      item("Gani hahaha", 552, 80, false),
    ],
    {
      conversationRect: {
        top: 64,
        left: 0,
        right: 704,
        bottom: 714,
      },
    }
  );

  assert.deepEqual(
    filtered.map((message) => message.text),
    [
      "Gitanggal nko ako oi hahahaha sayang",
      "gagoo",
      "kailangan man tu kay daghan kaaug missing values",
      "Gani hahaha",
    ]
  );
});

test("filterMessengerTextItems drops known conversation title text from headers", () => {
  const filtered = filterMessengerTextItems(
    [
      item("Reyah Lina", 28, 62, false),
      item("You", 80, 42, false),
      item("https://netflix.com/?nftoken=BgjXuOvcAxLCAaXD0dSp5eQVRjwA7I0dP", 96, 42, false),
      item("hope you had a nicee dayy foo of worship", 300, 350, true),
      item("have a good rest and sleep foo eyaa", 388, 388, true),
    ],
    {
      blockedExactTexts: ["Reyah Lina"],
      conversationRect: {
        top: 0,
        left: 0,
        right: 704,
        bottom: 714,
      },
    }
  );

  assert.deepEqual(
    filtered.map((message) => message.text),
    [
      "hope you had a nicee dayy foo of worship",
      "have a good rest and sleep foo eyaa",
    ]
  );
});

test("filterMessengerTextItems drops duplicate wrapper and child text candidates", () => {
  const filtered = filterMessengerTextItems([
    item("Kumusta ka?", 120, 420, true, { width: 140, height: 36 }),
    item("Kumusta ka?", 126, 432, true, { width: 110, height: 22 }),
    item("Okay ra", 170, 82, false, { width: 84, height: 30 }),
    item("Okay ra", 176, 94, false, { width: 64, height: 20 }),
    item("Kumusta ka?", 252, 420, true, { width: 140, height: 36 }),
  ]);

  assert.deepEqual(
    filtered.map((message) => ({ text: message.text, top: message.top, isOutgoing: message.isOutgoing })),
    [
      { text: "Kumusta ka?", top: 120, isOutgoing: true },
      { text: "Okay ra", top: 170, isOutgoing: false },
      { text: "Kumusta ka?", top: 252, isOutgoing: true },
    ]
  );
});

function item(text, top, left, isOutgoing, overrides = {}) {
  return { text, top, left, width: text.length * 8, height: 24, isOutgoing, ...overrides };
}
