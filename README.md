# Smart Cart - AI Price Tracker Chrome Extension

Smart Cart is a Manifest V3 Chrome extension for Amazon and Flipkart product pages. It uses Gemini in a multi-turn tool-calling loop to answer one question: should you buy this product now, or wait for a better price?

The extension combines:

- live DOM scraping from the current product tab
- Gemini-generated analysis and final verdict
- local alert storage and hourly background price monitoring
- a popup UI that shows reasoning cards, logs, token counts, and active alerts

The project follows a simple agent pattern: the model decides what it needs next, the extension runs the requested tool, the result is fed back into the running conversation, and the loop continues until the popup can render a final buy-now or wait decision.

## Visual Summary

```mermaid
flowchart LR
	U[User] --> P[Popup]
	P --> G[Gemini]
	G --> P
	P --> C[Product Page Scraper]
	P --> H[History and Coupon Tools]
	P --> A[Alert Tool]
	A --> B[Background Worker]
	B --> N[Notification]
	N --> U
```

In one line: the popup asks Gemini what to do next, runs the requested shopping tools locally, and can hand off long-running price tracking to the background worker.

## What It Supports

- Amazon India
- Amazon US
- Flipkart

## How It Works

The popup runs a tool-calling agent with four tools:

1. `scrape_product_page`
2. `check_price_history`
3. `check_discount_coupons`
4. `set_price_alert`

Flow:

1. User opens a product page.
2. User opens the extension popup and submits the URL.
3. Gemini calls `scrape_product_page` to get live product data.
4. Gemini calls `check_price_history` for a 90-day heuristic analysis.
5. Gemini calls `check_discount_coupons` for estimated bank, coupon, and cashback savings.
6. If the effective price is still too high, Gemini can call `set_price_alert`.
7. The popup displays the final buy-now or wait recommendation.

Important note:

- price history and coupon data are generated locally with deterministic heuristics
- alert monitoring is real and runs through Chrome alarms in the background worker

## Agent Flow

The popup keeps the full interaction history for the current run and uses it on each model call. That gives the extension a clear multi-step loop instead of a one-shot prompt.

- the model can request a tool instead of guessing
- the tool result is appended back into the conversation
- the popup renders each response, tool call, and tool result as visible reasoning cards
- the run ends only when the model returns a final answer with enough context

## Project Structure

```text
smart-fake-cart/
├── manifest.json
├── popup.html
├── popup.js
├── background.js
├── content.js
├── styles.css
├── HOW_IT_WORKS.md
└── icons/
```

## Setup

### 1. Load the extension in Chrome

1. Open `chrome://extensions/`
2. Enable Developer Mode
3. Click Load unpacked
4. Select the `smart-fake-cart` folder

### 2. Get a Gemini API key

1. Open https://aistudio.google.com/apikey
2. Create a Google AI Studio API key
3. Copy the key that starts with `AIza`

### 3. Connect the popup

1. Click the Smart Cart extension icon
2. Paste the Gemini API key
3. Optionally fetch and select another Gemini model
4. Click Connect

## Usage

1. Open an Amazon or Flipkart product page
2. Open the extension popup
3. Click the current-tab button or paste the product URL manually
4. Click `Ask Agent: Should I buy now?`
5. Watch the analysis cards and logs as the agent runs
6. The logs tab shows a session-style trace with iterations, tool calls, timings, and structured request/result payloads
7. If an alert is created, track it in the Price Alerts panel

## Alerts

If the agent decides the current price is too high, it can create an alert.

Alert behavior:

- alert configuration is stored in `chrome.storage.local`
- the popup asks the background worker to create a Chrome alarm
- the background worker re-checks the page every 60 minutes
- if the price falls to or below the threshold, Chrome shows a notification
- the notification button opens the exact product tied to that alert

## Storage Used

The extension stores the following keys in `chrome.storage.local`:

- `apiKey`
- `geminiModel`
- `lastSession`
- `alerts`

`lastSession` is used to restore the previous reasoning chain, logs, and URL when the popup is reopened.

## Implementation Notes

- The runtime path is Gemini-only.
- The popup persists the last session so reopening it restores the previous URL, reasoning chain, and logs.
- The logs mix a readable session trace with structured payload logging for debugging.
- The background worker handles recurring alert checks separately from the popup UI.
- Scraping depends on Amazon and Flipkart DOM structure, so selector changes can break extraction.

## Full Technical Breakdown

See `HOW_IT_WORKS.md` for a full architecture and runtime breakdown.
