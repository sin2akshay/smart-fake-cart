// background.js — Smart Cart service worker
// Handles price monitoring alarms and browser notifications

chrome.runtime.onInstalled.addListener(() => {
  console.log("Smart Cart installed.");
});

// ── Alarm handler ──────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith("smartcart_")) return;

  const alertId = alarm.name.replace("smartcart_", "");

  const { alerts = {} } = await chrome.storage.local.get("alerts");
  const alert = alerts[alertId];
  if (!alert) return;

  console.log(`[SmartCart] Checking price for: ${alert.productName}`);

  try {
    const currentPrice = await fetchCurrentPrice(alert.productUrl);

    // Log the check
    const checkHistory = alert.checkHistory || [];
    checkHistory.push({ ts: Date.now(), price: currentPrice });
    if (checkHistory.length > 48) checkHistory.shift(); // keep last 48 checks
    alert.checkHistory = checkHistory;
    alert.lastChecked = Date.now();
    alert.lastPrice = currentPrice;

    if (currentPrice !== null && currentPrice <= alert.thresholdPrice) {
      // 🎉 Price dropped!
      alert.triggered = true;
      await sendNotification(
        alert.productName,
        currentPrice,
        alert.thresholdPrice,
        alert.productUrl,
      );
    }

    alerts[alertId] = alert;
    await chrome.storage.local.set({ alerts });
  } catch (err) {
    console.error("[SmartCart] Alarm check failed:", err);
  }
});

// ── Fetch & parse price from product page ──────────────────────────
async function fetchCurrentPrice(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "en-IN,en;q=0.9",
      },
    });
    const html = await res.text();

    // Amazon price patterns
    const amazonPatterns = [
      /<span class="a-price-whole">([0-9,]+)<\/span>/,
      /id="priceblock_ourprice"[^>]*>.*?₹\s*([\d,]+)/s,
      /class="apexPriceToPay"[^>]*>.*?<span[^>]*>([\d,]+)/s,
    ];

    // Flipkart price patterns
    const flipkartPatterns = [
      /class="[^"]*_30jeq3[^"]*"[^>]*>₹([\d,]+)/,
      /class="[^"]*Nx9bqj[^"]*"[^>]*>₹([\d,]+)/,
    ];

    const patterns = url.includes("amazon") ? amazonPatterns : flipkartPatterns;

    for (const pat of patterns) {
      const m = html.match(pat);
      if (m) {
        const price = parseInt(m[1].replace(/,/g, ""), 10);
        if (!isNaN(price)) return price;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Send Chrome notification ───────────────────────────────────────
async function sendNotification(productName, currentPrice, threshold, url) {
  const short =
    productName.length > 50 ? productName.slice(0, 50) + "…" : productName;

  chrome.notifications.create(`smartcart_notif_${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "🛒 Smart Cart — Price Drop!",
    message: `${short} is now ₹${currentPrice.toLocaleString()} (below your ₹${threshold.toLocaleString()} target!)`,
    buttons: [{ title: "Open Product" }],
    priority: 2,
  });
}

// ── Notification click — open product URL ─────────────────────────
chrome.notifications.onButtonClicked.addListener(
  async (notifId, buttonIndex) => {
    if (buttonIndex !== 0) return;
    const { alerts = {} } = await chrome.storage.local.get("alerts");
    for (const a of Object.values(alerts)) {
      if (a.triggered) {
        chrome.tabs.create({ url: a.productUrl });
        break;
      }
    }
  },
);

// ── Message handler from popup ─────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "SET_ALARM") {
    const { alertId, periodInMinutes } = msg;
    chrome.alarms.create(`smartcart_${alertId}`, {
      delayInMinutes: periodInMinutes,
      periodInMinutes,
    });
    sendResponse({ ok: true });
  }

  if (msg.action === "CLEAR_ALARM") {
    chrome.alarms.clear(`smartcart_${msg.alertId}`);
    sendResponse({ ok: true });
  }

  if (msg.action === "GET_ALARMS") {
    chrome.alarms.getAll((all) => {
      sendResponse({ alarms: all });
    });
    return true;
  }

  return true;
});
