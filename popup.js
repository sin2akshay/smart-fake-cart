// popup.js — Smart Cart AI Agent
// Redesigned: markdown rendering, structured step cards, clean UI
"use strict";

// ── API ────────────────────────────────────────────────────────────
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const ALARM_PERIOD = 60;
const THROTTLE_MS = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GEMINI_SYSTEM_PROMPT = `You are a helpful AI shopping agent that can use tools to answer questions accurately.

You have access to shopping tools provided separately.

IMPORTANT RULES:
- Use tools when you need real product data, price comparisons, discount analysis, or alert setup.
- Follow this exact order for product analysis: 1) scrape_product_page, 2) check_price_history, 3) check_discount_coupons, 4) set_price_alert only if the price is still above the recommended buy price after discounts.
- Never skip steps 1-3 during a normal product analysis.
- After receiving a tool result, either use another tool or provide your final answer.
- Do not guess product details when a tool can provide them.
- Final user-facing answers should use markdown with **bold**, ### sections, and - bullets.`;

// ── Tool schemas ────────────────────────────────────────────────────
const TOOL_DEFS = [
  {
    name: "scrape_product_page",
    description:
      "Extracts product name, current price, rating, and store from the active Amazon/Flipkart tab. Call this FIRST.",
    params: {
      type: "object",
      properties: { url: { type: "string", description: "Product URL" } },
      required: ["url"],
    },
  },
  {
    name: "check_price_history",
    description:
      "Generates a simulated 90-day price history using local heuristics, then returns average, min, max, 7-day trend, verdict, and recommended buy price.",
    params: {
      type: "object",
      properties: {
        product_name: { type: "string" },
        current_price: { type: "number" },
        currency: { type: "string" },
      },
      required: ["product_name", "current_price"],
    },
  },
  {
    name: "set_price_alert",
    description:
      "Sets a Chrome alarm to monitor price every 60 min and send a notification when it drops to or below the threshold. Call this when price is above recommended buy price.",
    params: {
      type: "object",
      properties: {
        product_url: { type: "string" },
        product_name: { type: "string" },
        threshold_price: { type: "number" },
        current_price: { type: "number" },
        currency: { type: "string" },
      },
      required: [
        "product_url",
        "product_name",
        "threshold_price",
        "current_price",
      ],
    },
  },
  {
    name: "check_discount_coupons",
    description:
      "Generates simulated discount coupons, bank card offers, cashback deals, and EMI options for a product on Amazon or Flipkart. ALWAYS call this as step 3, after check_price_history. Returns a list of illustrative offers and the best effective price after discounts.",
    params: {
      type: "object",
      properties: {
        product_name: {
          type: "string",
          description: "Product name to find coupons for",
        },
        current_price: { type: "number", description: "Current listed price" },
        store: {
          type: "string",
          description: "Store name: Amazon or Flipkart",
        },
        currency: { type: "string", description: "Currency code e.g. INR" },
      },
      required: ["product_name", "current_price", "store"],
    },
  },
];

const GEMINI_TOOLS = [
  {
    functionDeclarations: TOOL_DEFS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.params,
    })),
  },
];

// ── DOM ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const screenSetup = $("screen-setup");
const screenMain = $("screen-main");
const apiKeyInput = $("api-key-input");
const btnSaveKey = $("btn-save-key");
const btnSettings = $("btn-settings");
const productUrlInput = $("product-url");
const btnCurrentTab = $("btn-current-tab");
const btnAnalyze = $("btn-analyze");
const btnClear = $("btn-clear");
const chainWrap = $("chain-wrap");
const chainEl = $("chain");
const alertsPanel = $("alerts-panel");
const alertsList = $("alerts-list");
const alertCount = $("alert-count");
const statusText = $("status-text");
const sbStep = $("sb-step");
const sbTokens = $("sb-tokens");
const sbTimer = $("sb-timer");

// ── Statusbar state ────────────────────────────────────────────────
let timerInterval = null;
let timerStart = 0;
let totalTokens = 0;
let currentStep = 0;

function sbStartRun() {
  totalTokens = 0;
  currentStep = 0;
  timerStart = Date.now();
  sbTimer.classList.remove("hidden");
  sbTimer.classList.add("running");
  sbStep.classList.remove("hidden");
  sbTokens.classList.remove("hidden");
  sbStep.textContent = "step 0";
  sbTokens.textContent = "0 tok";
  sbTimer.textContent = "0:00";
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - timerStart) / 1000);
    sbTimer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
  statusText.className = "sb-status running";
}

function sbStopRun() {
  clearInterval(timerInterval);
  sbTimer.classList.remove("running");
  statusText.className = "sb-status";
}

function sbAddTokens(input = 0, output = 0) {
  totalTokens += input + output;
  sbTokens.textContent =
    totalTokens >= 1000
      ? `${(totalTokens / 1000).toFixed(1)}k tok`
      : `${totalTokens} tok`;
}

function sbSetStep(n) {
  currentStep = n;
  sbStep.textContent = `step ${n}`;
}
const providerPill = $("active-provider-pill");
const modelSelect = $("model-select");
const btnFetchModels = $("btn-fetch-models");
const fetchStatus = $("fetch-status");

// ── Log refs ───────────────────────────────────────────────────────
const logTerminal = $("log-terminal");
const logCountEl = $("log-count");
const logDot = $("log-dot");
const btnCopyLogs = $("btn-copy-logs");
const btnClearLogs = $("btn-clear-logs");

let logLines = [];

// ── Tab switching ──────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.toggle("active", t === tab));
    document
      .querySelectorAll(".tab-content")
      .forEach((c) =>
        c.classList.toggle("hidden", c.id !== `tab-${tab.dataset.tab}`),
      );
    // Scroll log to bottom when switching to logs tab
    if (tab.dataset.tab === "logs")
      logTerminal.scrollTop = logTerminal.scrollHeight;
  });
});

btnCopyLogs?.addEventListener("click", () => {
  const text = logLines
    .map((l) => `[${l.ts}] [${l.level.toUpperCase().padEnd(4)}] ${l.msg}`)
    .join("\n");
  navigator.clipboard.writeText(text).then(() => {
    btnCopyLogs.textContent = "Copied!";
    setTimeout(() => {
      btnCopyLogs.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2 2v1"/></svg> Copy all`;
    }, 1500);
  });
});

btnClearLogs?.addEventListener("click", () => {
  logLines = [];
  logTerminal.innerHTML = "";
  logCountEl.textContent = "0";
  logDot.classList.remove("active");
});

// ── Core log function ──────────────────────────────────────────────

function formatLogMsg(level, raw) {
  // Trim leading whitespace from every line
  let msg = raw.replace(/^\s+/gm, "");

  // For DATA lines: find trailing JSON object/array and pretty-print it
  if (level === "data") {
    const match = msg.match(/([\s\S]*?)(\{[\s\S]+\}|\[[\s\S]+\])$/);
    if (match) {
      try {
        const prefix = match[1].trimEnd();
        const parsed = JSON.parse(match[2]);
        const pretty = JSON.stringify(parsed, null, 2);
        return (prefix ? prefix + "\n" : "") + pretty;
      } catch {
        /* not valid JSON, fall through */
      }
    }
  }
  return msg;
}

function log(level, msg) {
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8); // HH:MM:SS

  const displayMsg = formatLogMsg(level, msg);
  logLines.push({ ts, level, msg: displayMsg });

  logDot.classList.add("active");
  logCountEl.textContent = logLines.length;

  const row = document.createElement("div");
  row.className = "log-line";
  row.innerHTML = `<span class="ll-time">${ts}</span><span class="ll-level level-${level}">${level}</span><span class="ll-msg">${escLog(displayMsg)}</span>`;
  logTerminal.appendChild(row);

  // Auto-scroll only if logs tab is currently active
  if (!$("tab-logs").classList.contains("hidden")) {
    logTerminal.scrollTop = logTerminal.scrollHeight;
  }
}

function escLog(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function logDone() {
  logDot.classList.remove("active");
  chrome.storage.local.set({
    lastSession: {
      chainHtml: chainEl.innerHTML,
      logLines,
      url: productUrlInput.value,
    },
  });
}

function toSingleLineJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ══════════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════════
(async () => {
  const { apiKey, geminiModel, lastSession } = await chrome.storage.local.get([
    "apiKey",
    "geminiModel",
    "lastSession",
  ]);
  if (geminiModel)
    [...modelSelect.options].forEach((o) => {
      if (o.value === geminiModel) o.selected = true;
    });
  apiKey ? showMain() : showSetup();

  if (lastSession?.chainHtml) {
    if (lastSession.url) productUrlInput.value = lastSession.url;
    chainEl.innerHTML = lastSession.chainHtml;
    chainWrap.classList.remove("hidden");
    chainEl.querySelectorAll(".step-card").forEach((card) => {
      const tag = card.querySelector(".step-tag");
      if (tag)
        tag.addEventListener("click", () => card.classList.toggle("collapsed"));
    });
    if (lastSession.logLines?.length) {
      logLines = lastSession.logLines;
      logLines.forEach(({ ts, level, msg }) => {
        const row = document.createElement("div");
        row.className = "log-line";
        row.innerHTML = `<span class="ll-time">${ts}</span><span class="ll-level level-${level}">${level}</span><span class="ll-msg">${escLog(msg)}</span>`;
        logTerminal.appendChild(row);
      });
      logCountEl.textContent = logLines.length;
    }
  }
  loadAlerts();
})();

// ══════════════════════════════════════════════════════════════════
//  NAVIGATION & SETUP  (Gemini only)
// ══════════════════════════════════════════════════════════════════
function showSetup() {
  screenSetup.classList.remove("hidden");
  screenMain.classList.add("hidden");
}
function showMain() {
  screenSetup.classList.add("hidden");
  screenMain.classList.remove("hidden");
  chrome.storage.local.get("geminiModel").then(({ geminiModel }) => {
    const m = (geminiModel || "gemini-3.1-flash-lite-preview").replace(
      "gemini-",
      "",
    );
    providerPill.textContent = `✦ Gemini · ${m}`;
    providerPill.className = "provider-pill gemini-pill";
    providerPill.classList.remove("hidden");
  });
}

btnFetchModels?.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    fetchStatus.textContent = "Enter your API key first.";
    return;
  }
  btnFetchModels.textContent = "Fetching…";
  btnFetchModels.disabled = true;
  fetchStatus.textContent = "";
  try {
    const res = await fetch(`${GEMINI_BASE}/models?key=${key}&pageSize=50`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = (data.models || []).filter(
      (m) =>
        m.name.includes("gemini") &&
        (m.supportedGenerationMethods || []).includes("generateContent"),
    );
    if (!models.length) {
      fetchStatus.textContent = "No models found.";
      return;
    }
    modelSelect.innerHTML = "";
    models.forEach((m) => {
      const id = m.name.replace("models/", "");
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id;
      if (id === "gemini-3.1-flash-lite-preview") opt.selected = true;
      modelSelect.appendChild(opt);
    });
    fetchStatus.style.color = "var(--green)";
    fetchStatus.textContent = `✓ ${models.length} models loaded`;
  } catch (e) {
    fetchStatus.style.color = "var(--red)";
    fetchStatus.textContent = `Error: ${e.message}`;
  } finally {
    btnFetchModels.textContent = "↻ Fetch from API";
    btnFetchModels.disabled = false;
  }
});

btnSaveKey.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key.startsWith("AI")) {
    flash("Invalid key — should start with AIza…");
    return;
  }
  await chrome.storage.local.set({
    apiKey: key,
    geminiModel: modelSelect.value,
  });
  showMain();
});

btnSettings.addEventListener("click", async () => {
  const { apiKey, geminiModel } = await chrome.storage.local.get([
    "apiKey",
    "geminiModel",
  ]);
  if (apiKey) apiKeyInput.value = apiKey;
  if (geminiModel)
    [...modelSelect.options].forEach((o) => {
      if (o.value === geminiModel) o.selected = true;
    });
  showSetup();
});

btnCurrentTab.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) productUrlInput.value = tab.url;
});

btnClear.addEventListener("click", () => {
  chainEl.innerHTML = "";
  chainWrap.classList.add("hidden");
  chrome.storage.local.remove("lastSession");
});

// ══════════════════════════════════════════════════════════════════
//  ANALYZE
// ══════════════════════════════════════════════════════════════════
btnAnalyze.addEventListener("click", async () => {
  const url = productUrlInput.value.trim();
  if (!url) {
    flash("Paste a URL first!");
    return;
  }
  if (!url.includes("amazon") && !url.includes("flipkart")) {
    flash("Amazon / Flipkart only!");
    return;
  }

  const { apiKey, geminiModel } = await chrome.storage.local.get([
    "apiKey",
    "geminiModel",
  ]);
  if (!apiKey) {
    showSetup();
    return;
  }

  chainEl.innerHTML = "";
  chainWrap.classList.remove("hidden");
  btnAnalyze.disabled = true;
  setStatus("Agent running…");

  logLines = [];
  logTerminal.innerHTML = "";
  logCountEl.textContent = "0";
  logDot.classList.remove("active");
  log(
    "info",
    `▶ Starting agent — model: ${geminiModel || "gemini-3.1-flash-lite-preview"}`,
  );
  sbStartRun();

  try {
    await runGemini(
      url,
      apiKey,
      geminiModel || "gemini-3.1-flash-lite-preview",
    );
  } catch (err) {
    addError(err.message);
    log("warn", `✖ Agent error: ${err.message}`);
    statusText.className = "sb-status error";
  } finally {
    btnAnalyze.disabled = false;
    setStatus("Done");
    logDone();
    sbStopRun();
  }
});

// ══════════════════════════════════════════════════════════════════
//  AGENT — GEMINI
// ══════════════════════════════════════════════════════════════════
async function runGemini(productUrl, apiKey, model) {
  const sysInstr = {
    parts: [
      {
        text: GEMINI_SYSTEM_PROMPT,
      },
    ],
  };
  const contents = [
    {
      role: "user",
      parts: [
        {
          text: `Product URL: ${productUrl}\n\nTask — follow ALL steps in order:\n1. scrape_product_page → get name & current price\n2. check_price_history → 90-day price analysis\n3. check_discount_coupons → find bank offers, coupons, cashback (ALWAYS do this step)\n4. If price is still above recommended buy price after discounts, call set_price_alert\n5. Final verdict: BUY NOW or WAIT, showing best effective price after coupons.`,
        },
      ],
    },
  ];

  log("info", `📋 System instruction set. Model: ${model}`);
  log("info", "============================================================");
  log("info", `User: Analyse product at ${productUrl}`);
  log("info", "============================================================");
  addUserStep(productUrl);

  let loops = 0;
  while (loops++ < 8) {
    log("info", `--- Iteration ${loops} ---`);
    setStatus(`Gemini thinking… (step ${loops})`);
    sbSetStep(loops);
    const endpoint = `${GEMINI_BASE}/models/${model}:generateContent`;
    log("llm", `━━ LLM CALL #${loops} → POST ${endpoint}`);
    log(
      "data",
      `model=${model} | maxOutputTokens=1500 | tools=${GEMINI_TOOLS[0].functionDeclarations.length} | turns=${contents.length}`,
    );

    if (loops > 1) {
      log("info", `⏳ Throttling ${THROTTLE_MS / 1000}s before next LLM call…`);
      setStatus(`Waiting ${THROTTLE_MS / 1000}s (rate limit)…`);
      await sleep(THROTTLE_MS);
    }

    const t0 = Date.now();
    const raw = await apiFetch(`${endpoint}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: sysInstr,
        tools: GEMINI_TOOLS,
        tool_config: { function_calling_config: { mode: "AUTO" } },
        generationConfig: { maxOutputTokens: 1500, temperature: 0.1 },
      }),
    });
    const ms = Date.now() - t0;

    const cand = raw.candidates?.[0];
    log(
      "resp",
      `← Response in ${ms}ms | candidates=${raw.candidates?.length ?? 0} | finish="${cand?.finishReason ?? "?"}"`,
    );
    if (raw.usageMetadata) {
      log(
        "data",
        `tokens: prompt=${raw.usageMetadata.promptTokenCount} output=${raw.usageMetadata.candidatesTokenCount}`,
      );
      sbAddTokens(
        raw.usageMetadata.promptTokenCount || 0,
        raw.usageMetadata.candidatesTokenCount || 0,
      );
    }

    if (!cand) {
      addError("No response from Gemini: " + JSON.stringify(raw));
      break;
    }
    const parts = cand.content?.parts || [];

    const textParts = parts.filter((p) => p.text);
    const llmText = textParts.length
      ? textParts.map((p) => p.text).join("\n")
      : "";
    if (textParts.length) {
      addAIStep(model.replace("models/", ""), llmText);
    }

    contents.push({ role: "model", parts });

    const fnCalls = parts.filter((p) => p.functionCall);
    if (!fnCalls.length) {
      if (llmText) {
        log(
          "info",
          "============================================================",
        );
        log("resp", `Agent Answer: ${llmText}`);
        log(
          "info",
          "============================================================",
        );
      }
      log(
        "info",
        `✅ Agent finished (no more function calls) after ${loops} LLM call(s)`,
      );
      break;
    }

    const responseParts = [];
    for (const fc of fnCalls) {
      const { name, args } = fc.functionCall;
      log("tool", `→ Calling tool: ${name}(${toSingleLineJson(args)})`);
      log("data", `Args:\n${JSON.stringify(args, null, 2)}`);
      const cardId = addToolCallStep(name, args);
      setStatus(`Running: ${name}…`);
      const tt0 = Date.now();
      let result;
      try {
        result = await executeTool(name, args, productUrl);
        log("tool", `✓ ${name} finished in ${Date.now() - tt0}ms`);
        log("data", `Result:\n${JSON.stringify(result, null, 2)}`);
      } catch (e) {
        result = { error: e.message };
        log("warn", `✖ ${name} threw: ${e.message}`);
      }
      finalizeToolCard(cardId, name, result);
      responseParts.push({
        functionResponse: {
          name,
          response: { content: JSON.stringify(result) },
        },
      });
    }
    log(
      "info",
      `📤 Sending ${responseParts.length} function response(s) back to LLM`,
    );
    contents.push({ role: "user", parts: responseParts });
  }
}

// ══════════════════════════════════════════════════════════════════
//  TOOLS
// ══════════════════════════════════════════════════════════════════
async function executeTool(name, input, ctxUrl) {
  switch (name) {
    case "scrape_product_page":
      return toolScrape(input.url || ctxUrl);
    case "check_price_history":
      return toolPriceHistory(
        input.product_name,
        input.current_price,
        input.currency || "INR",
      );
    case "check_discount_coupons":
      return toolCheckCoupons(
        input.product_name,
        input.current_price,
        input.store || "Amazon",
        input.currency || "INR",
      );
    case "set_price_alert":
      return toolSetAlert(
        input.product_url || ctxUrl,
        input.product_name,
        input.threshold_price,
        input.current_price,
        input.currency || "INR",
      );
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function toolScrape(url) {
  log("tool", `🌐 scrape_product_page: fetching DOM for ${url.slice(0, 60)}…`);
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({});
    tab = tabs.find((t) => t.url?.startsWith(url.split("?")[0]));
    if (!tab)
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab)
    return {
      success: false,
      error: "No product tab found. Open the product page first.",
    };

  try {
    const result = await new Promise((res, rej) => {
      chrome.tabs.sendMessage(tab.id, { action: "SCRAPE_PRODUCT" }, (r) => {
        if (chrome.runtime.lastError)
          rej(new Error(chrome.runtime.lastError.message));
        else res(r);
      });
    });
    if (result?.success) return result;
  } catch {}

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const isAZ = location.href.includes("amazon");
        let title = "",
          price = null;
        if (isAZ) {
          const t =
            document.querySelector("#productTitle") ||
            document.querySelector(".product-title-word-break");
          const p =
            document.querySelector(".a-price-whole") ||
            document.querySelector(".priceToPay .a-price-whole") ||
            document.querySelector(".apexPriceToPay .a-price-whole");
          title = t?.textContent.trim() || "";
          if (p) price = parseInt(p.textContent.replace(/\D/g, ""), 10) || null;
          return {
            success: !!(title && price),
            store: "Amazon",
            title,
            price,
            currency: location.hostname.includes(".in") ? "INR" : "USD",
            url: location.href,
          };
        }
        const t =
          document.querySelector(".B_NuCI") ||
          document.querySelector("h1.yhB1nd");
        const p =
          document.querySelector("._30jeq3._16Jk6d") ||
          document.querySelector("._30jeq3") ||
          document.querySelector(".Nx9bqj");
        title = t?.textContent.trim() || "";
        if (p) price = parseInt(p.textContent.replace(/\D/g, ""), 10) || null;
        return {
          success: !!(title && price),
          store: "Flipkart",
          title,
          price,
          currency: "INR",
          url: location.href,
        };
      },
    });
    return result || { success: false, error: "Script returned nothing" };
  } catch (e) {
    log("warn", `scrape_product_page injection failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function toolPriceHistory(productName, currentPrice, currency = "INR") {
  log(
    "tool",
    `📊 check_price_history: "${productName.slice(0, 50)}" @ ${currency} ${currentPrice}`,
  );
  let seed = [...productName].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  };

  const days = 90,
    basePrice = Math.round(currentPrice * (1.05 + rand() * 0.3));
  const prices = Array.from({ length: days + 1 }, (_, i) => {
    const v = (rand() - 0.5) * 0.08 * basePrice;
    const s = rand() < 0.04 ? 0.7 + rand() * 0.15 : 1;
    const d = 1 - (days - i) * 0.0008;
    return Math.max(
      Math.round((basePrice + v) * s * d),
      Math.round(currentPrice * 0.75),
    );
  });

  const avg = Math.round(prices.reduce((a, b) => a + b) / prices.length);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const last7 = prices.slice(-7).reduce((a, b) => a + b) / 7;
  const prev7 = prices.slice(-14, -7).reduce((a, b) => a + b) / 7;
  const trend =
    last7 < prev7 ? "📉 Falling" : last7 > prev7 ? "📈 Rising" : "➡ Stable";
  const vsAvg = (((currentPrice - avg) / avg) * 100).toFixed(1);
  const vsMin = (((currentPrice - min) / min) * 100).toFixed(1);

  let verdict,
    recommendation,
    recommendedBuyPrice = Math.round(avg * 0.88);
  if (currentPrice <= min * 1.03) {
    verdict = "EXCELLENT";
    recommendation = "BUY NOW. Best price in 90 days.";
    recommendedBuyPrice = currentPrice;
  } else if (currentPrice <= avg * 0.92) {
    verdict = "GOOD";
    recommendation = "BUY NOW. Well below average price.";
    recommendedBuyPrice = currentPrice;
  } else if (currentPrice <= avg * 1.02) {
    verdict = "FAIR";
    recommendation = "Could wait. Price may dip lower.";
  } else {
    verdict = "EXPENSIVE";
    recommendation = "WAIT. Price is inflated. Set an alert.";
  }

  log(
    "tool",
    `   Verdict: ${verdict} | avg=${currency}${avg} min=${currency}${min} trend=${trend}`,
  );
  return {
    productName,
    currentPrice,
    currency,
    simulated: true,
    dataSource: "local heuristic simulation",
    avgPrice90d: avg,
    minPrice90d: min,
    maxPrice90d: max,
    vsAverage: `${vsAvg > 0 ? "+" : ""}${vsAvg}%`,
    vsAllTimeLow: `+${vsMin}%`,
    trend7d: trend,
    verdict,
    recommendation,
    recommendedBuyPrice,
    note: "Simulated 90-day history generated locally from heuristics, not live market data.",
  };
}

async function toolCheckCoupons(
  productName,
  currentPrice,
  store = "Amazon",
  currency = "INR",
) {
  log(
    "tool",
    `🏷️ check_discount_coupons: "${productName.slice(0, 50)}" on ${store}`,
  );

  // Seeded random so same product always gets same offers
  let seed = [...(productName + store)].reduce(
    (a, c) => a + c.charCodeAt(0),
    0,
  );
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  };

  const sym = currency === "INR" ? "₹" : "$";

  // Bank card offers — very common on Amazon India & Flipkart
  const bankOffers = [
    {
      bank: "HDFC Bank",
      type: "Credit Card",
      pct: 10,
      cap: 1500,
      code: "HDFC10",
    },
    { bank: "SBI", type: "Debit Card", pct: 8, cap: 1000, code: "SBI8" },
    {
      bank: "ICICI Bank",
      type: "Credit Card",
      pct: 7,
      cap: 1200,
      code: "ICICI7",
    },
    { bank: "Axis Bank", type: "Credit Card", pct: 5, cap: 800, code: null },
    { bank: "Kotak", type: "Debit Card", pct: 6, cap: 750, code: "KOTAK6" },
    {
      bank: "IDFC First",
      type: "Credit Card",
      pct: 12,
      cap: 2000,
      code: "IDFC12",
    },
    {
      bank: "IndusInd",
      type: "Credit Card",
      pct: 9,
      cap: 1100,
      code: "INDUS9",
    },
  ];

  // Coupon codes
  const coupons = [
    { code: "SAVE5", pct: 5, maxDiscount: 500, minOrder: 5000 },
    { code: "FLASH15", pct: 15, maxDiscount: 2000, minOrder: 15000 },
    { code: "TECH10", pct: 10, maxDiscount: 1500, minOrder: 8000 },
    { code: "NEWUSER20", pct: 20, maxDiscount: 1000, minOrder: 2000 },
    { code: "WEEKEND12", pct: 12, maxDiscount: 1800, minOrder: 10000 },
  ];

  // Cashback platforms
  const cashbackPlatforms = [
    { name: "Amazon Pay", pct: 5, maxCB: 300 },
    { name: "Google Pay", pct: 3, maxCB: 200 },
    { name: "PhonePe", pct: 4, maxCB: 250 },
    { name: "Paytm", pct: 6, maxCB: 400 },
    { name: "CRED", pct: 8, maxCB: 600 },
  ];

  // Pick 2 random bank offers
  const selectedBanks = [];
  const bankPool = [...bankOffers].sort(() => rand() - 0.5).slice(0, 2);
  for (const b of bankPool) {
    const rawDiscount = Math.round((currentPrice * b.pct) / 100);
    const discount = Math.min(rawDiscount, b.cap);
    selectedBanks.push({
      ...b,
      discount,
      effectivePrice: currentPrice - discount,
    });
  }

  // Pick 1-2 coupons valid for this price
  const validCoupons = coupons
    .filter((c) => currentPrice >= c.minOrder)
    .sort(() => rand() - 0.5)
    .slice(0, rand() > 0.4 ? 2 : 1);
  const selectedCoupons = validCoupons.map((c) => {
    const rawDiscount = Math.round((currentPrice * c.pct) / 100);
    const discount = Math.min(rawDiscount, c.maxDiscount);
    return { ...c, discount, effectivePrice: currentPrice - discount };
  });

  // Pick 1 cashback platform
  const cb = cashbackPlatforms[Math.floor(rand() * cashbackPlatforms.length)];
  const cbAmount = Math.min(
    Math.round((currentPrice * cb.pct) / 100),
    cb.maxCB,
  );
  const cashback = { ...cb, cashbackAmount: cbAmount };

  // Best deal across all offers
  const allEffective = [
    ...selectedBanks.map((b) => b.effectivePrice),
    ...selectedCoupons.map((c) => c.effectivePrice),
    currentPrice - cbAmount,
  ];
  const bestEffectivePrice = Math.min(...allEffective);
  const totalSavings = currentPrice - bestEffectivePrice;
  const savingsPct = ((totalSavings / currentPrice) * 100).toFixed(1);

  log(
    "tool",
    `   Found ${selectedBanks.length} bank offers, ${selectedCoupons.length} coupons, 1 cashback | Best: ${sym}${bestEffectivePrice.toLocaleString()} (save ${savingsPct}%)`,
  );

  return {
    store,
    currency,
    currentPrice,
    simulated: true,
    dataSource: "local offer simulation",
    bankOffers: selectedBanks,
    coupons: selectedCoupons,
    cashback,
    bestEffectivePrice,
    totalSavings,
    savingsPct: `${savingsPct}%`,
    note: "Offers are simulated examples generated locally. Verify live offers on the store before purchase.",
  };
}

async function toolSetAlert(
  url,
  productName,
  thresholdPrice,
  currentPrice,
  currency = "INR",
) {
  log(
    "tool",
    `🔔 set_price_alert: threshold=${currency}${thresholdPrice} current=${currency}${currentPrice}`,
  );
  const alertId = `alert_${Date.now()}`;
  const alert = {
    id: alertId,
    productUrl: url,
    productName,
    thresholdPrice,
    currentPrice,
    currency,
    createdAt: Date.now(),
    lastChecked: null,
    lastPrice: currentPrice,
    triggered: false,
    checkHistory: [],
  };
  const { alerts = {} } = await chrome.storage.local.get("alerts");
  alerts[alertId] = alert;
  await chrome.storage.local.set({ alerts });
  await chrome.runtime.sendMessage({
    action: "SET_ALARM",
    alertId,
    periodInMinutes: ALARM_PERIOD,
  });
  log(
    "tool",
    `   ✓ Chrome alarm created: id=${alertId} period=${ALARM_PERIOD}min`,
  );
  loadAlerts();
  return {
    success: true,
    alertId,
    thresholdPrice,
    currency,
    message: `Alert set at ${currency} ${thresholdPrice.toLocaleString()}. Checking every ${ALARM_PERIOD} min.`,
  };
}

// ══════════════════════════════════════════════════════════════════
//  UI — STEP CARDS
// ══════════════════════════════════════════════════════════════════

function addUserStep(url) {
  const domain = (() => {
    try {
      return new URL(url).hostname.replace("www.", "");
    } catch {
      return url.slice(0, 40);
    }
  })();
  const path = (() => {
    try {
      const p = new URL(url).pathname;
      return p.length > 36 ? p.slice(0, 36) + "…" : p;
    } catch {
      return "";
    }
  })();
  appendCard(`
    <div class="step-card step-user">
      <div class="step-tag">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        User Query
      </div>
      <div class="step-body">
        <div>Asking: <strong>Should I buy this now, or wait?</strong></div>
        <div class="url-line">${esc(domain)}${esc(path)}</div>
      </div>
    </div>
  `);
}

function addAIStep(modelName, rawText) {
  const html = renderMarkdown(rawText);
  const isWait = /wait|expensive|above average|inflated/i.test(rawText);
  const isBuy = /buy now|all.time low|below average/i.test(rawText);

  let bannerHtml = "";
  if (isBuy)
    bannerHtml = `<div class="verdict-banner verdict-buy"><span class="verdict-icon">✅</span> Recommended: BUY NOW</div>`;
  if (isWait)
    bannerHtml = `<div class="verdict-banner verdict-wait"><span class="verdict-icon">⏳</span> Recommended: WAIT for better price</div>`;

  appendCard(`
    <div class="step-card step-ai">
      <div class="step-tag">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
        Agent Response
        <span class="ai-model-label">${esc(modelName)}</span>
      </div>
      <div class="step-body">${html}${bannerHtml}</div>
    </div>
  `);
}

let cardSeq = 0;
function addToolCallStep(toolName, inputs) {
  const id = `tcard-${++cardSeq}`;
  const inputRows = Object.entries(inputs)
    .map(([k, v]) => {
      const isUrl = typeof v === "string" && v.startsWith("http");
      const valClass = isUrl ? "tool-input-val url-val" : "tool-input-val";
      const display = isUrl ? truncUrl(v) : esc(String(v));
      return `<div class="tool-input-row">
      <span class="tool-input-key">${esc(k)}</span>
      <span class="${valClass}">${display}</span>
    </div>`;
    })
    .join("");

  appendCard(`
    <div class="step-card step-tool" id="${id}">
      <div class="step-tag">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
        Tool Call &nbsp;<span class="tool-name-badge">${esc(toolName)}</span>
      </div>
      <div class="tool-inputs">${inputRows}</div>
      <div class="tool-spinner" id="${id}-spin">
        <div class="spinner-dots"><span></span><span></span><span></span></div>
        Running…
      </div>
    </div>
  `);
  return id;
}

// ══════════════════════════════════════════════════════════════════
//  RENDER HELPERS  (tool result displays)
// ══════════════════════════════════════════════════════════════════

function renderScrapeResult(r) {
  const sym = r.currency === "INR" ? "₹" : "$";
  return `
    <div class="tool-result-grid">
      <div class="tool-result-item" style="grid-column:1/-1">
        <span class="tri-key">Product</span>
        <span class="tri-val" style="font-family:var(--sans);font-size:12px">${esc(r.title || "—")}</span>
      </div>
      <div class="tool-result-item">
        <span class="tri-key">Current Price</span>
        <span class="tri-val" style="font-size:16px">${sym}${(r.price || 0).toLocaleString()}</span>
      </div>
      <div class="tool-result-item">
        <span class="tri-key">Store</span>
        <span class="tri-val">${esc(r.store || "—")}</span>
      </div>
      ${r.rating ? `<div class="tool-result-item"><span class="tri-key">Rating</span><span class="tri-val">⭐ ${r.rating}</span></div>` : ""}
    </div>`;
}

function renderHistoryResult(r) {
  const sym = r.currency === "INR" ? "₹" : "$";
  const fmt = (n) => sym + Number(n).toLocaleString();
  const verdictColor =
    r.verdict === "EXCELLENT" || r.verdict === "GOOD"
      ? "good"
      : r.verdict === "EXPENSIVE"
        ? "bad"
        : "warn";
  const noteHtml = r.note
    ? `<div class="coupon-note">${esc(r.note)}</div>`
    : "";

  return `
    <div class="tool-result-grid">
      <div class="tool-result-item">
        <span class="tri-key">90-Day Avg</span>
        <span class="tri-val">${fmt(r.avgPrice90d)}</span>
      </div>
      <div class="tool-result-item">
        <span class="tri-key">All-Time Low</span>
        <span class="tri-val good">${fmt(r.minPrice90d)}</span>
      </div>
      <div class="tool-result-item">
        <span class="tri-key">vs Average</span>
        <span class="tri-val ${parseFloat(r.vsAverage) < 0 ? "good" : "bad"}">${esc(r.vsAverage)}</span>
      </div>
      <div class="tool-result-item">
        <span class="tri-key">7-Day Trend</span>
        <span class="tri-val">${esc(r.trend7d)}</span>
      </div>
      <div class="tool-result-item" style="grid-column:1/-1">
        <span class="tri-key">Verdict</span>
        <span class="tri-val ${verdictColor}">${esc(r.verdict)} — ${esc(r.recommendation)}</span>
      </div>
      <div class="tool-result-item" style="grid-column:1/-1">
        <span class="tri-key">Recommended Buy Price</span>
        <span class="tri-val good">${fmt(r.recommendedBuyPrice)}</span>
      </div>
    </div>
    ${noteHtml}`;
}

function renderCouponsResult(r) {
  const sym = r.currency === "INR" ? "₹" : "$";
  const fmt = (n) => sym + Number(n).toLocaleString();

  const bankRows = r.bankOffers
    .map(
      (b) => `
    <div class="coupon-row">
      <span class="coupon-badge bank-badge">${esc(b.bank)}</span>
      <span class="coupon-detail">${b.pct}% off (up to ${fmt(b.cap)}) on ${esc(b.type)}</span>
      <span class="coupon-saving">−${fmt(b.discount)}</span>
    </div>`,
    )
    .join("");

  const couponRows = r.coupons
    .map(
      (c) => `
    <div class="coupon-row">
      <span class="coupon-badge code-badge">${esc(c.code)}</span>
      <span class="coupon-detail">${c.pct}% off, max ${fmt(c.maxDiscount)}</span>
      <span class="coupon-saving">−${fmt(c.discount)}</span>
    </div>`,
    )
    .join("");

  const cbRow = `
    <div class="coupon-row">
      <span class="coupon-badge cb-badge">${esc(r.cashback.name)}</span>
      <span class="coupon-detail">${r.cashback.pct}% cashback, max ${fmt(r.cashback.maxCB)}</span>
      <span class="coupon-saving">−${fmt(r.cashback.cashbackAmount)}</span>
    </div>`;

  return `
    <div class="coupon-section">
      <div class="coupon-group-label">🏦 Bank Offers</div>
      ${bankRows}
      <div class="coupon-group-label" style="margin-top:8px">🎟️ Coupon Codes</div>
      ${couponRows}
      <div class="coupon-group-label" style="margin-top:8px">💸 Cashback</div>
      ${cbRow}
      <div class="coupon-best">
        <div class="coupon-best-label">Best effective price</div>
        <div class="coupon-best-price">${fmt(r.bestEffectivePrice)} <span class="coupon-best-save">Save ${r.savingsPct} (${fmt(r.totalSavings)})</span></div>
      </div>
      <div class="coupon-note">${esc(r.note)}</div>
    </div>`;
}

function renderAlertResult(r) {
  const sym = r.currency === "INR" ? "₹" : "$";
  return `
    <div class="alert-set-body">
      <div>
        <div class="alert-threshold-display">
          <span class="alert-price-big">${sym}${Number(r.thresholdPrice).toLocaleString()}</span>
          <span class="alert-price-label">target price</span>
        </div>
      </div>
      <p class="alert-meta">🔔 ${esc(r.message || "Alert set successfully!")}</p>
    </div>`;
}

function addError(msg) {
  appendCard(`
    <div class="step-card step-error">
      <div class="step-tag">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Error
      </div>
      <div class="step-body">${esc(msg)}</div>
    </div>
  `);
}

function appendCard(html) {
  // Collapse every existing completed card (not ones mid-spinner)
  chainEl.querySelectorAll(".step-card").forEach((c) => {
    if (!c.querySelector(".tool-spinner")) c.classList.add("collapsed");
  });

  const tmp = document.createElement("div");
  tmp.innerHTML = html.trim();
  const card = tmp.firstChild;

  // Wrap everything after .step-tag in a .card-body for smooth collapse
  const tag = card.querySelector(".step-tag");
  if (tag) {
    const body = document.createElement("div");
    body.className = "card-body";
    while (tag.nextSibling) body.appendChild(tag.nextSibling);
    card.appendChild(body);

    // Chevron indicator
    const chev = document.createElement("span");
    chev.className = "tag-chevron";
    chev.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>`;
    tag.appendChild(chev);

    // Click tag to toggle collapse
    tag.addEventListener("click", () => card.classList.toggle("collapsed"));
  }

  chainEl.appendChild(card);
  chainEl.scrollTop = chainEl.scrollHeight;
}

// When a tool card is finalized (result received), append result into its .card-body
function finalizeToolCard(cardId, toolName, result) {
  const spin = document.getElementById(`${cardId}-spin`);
  if (spin) spin.remove();

  const card = document.getElementById(cardId);
  if (!card) return;

  const div = document.createElement("div");
  div.className = "tool-result";

  if (result.error) {
    div.innerHTML = `<div style="color:var(--red);font-size:12px">❌ ${esc(result.error)}</div>`;
  } else if (toolName === "scrape_product_page") {
    div.innerHTML = renderScrapeResult(result);
  } else if (toolName === "check_price_history") {
    div.innerHTML = renderHistoryResult(result);
  } else if (toolName === "check_discount_coupons") {
    div.innerHTML = renderCouponsResult(result);
  } else if (toolName === "set_price_alert") {
    div.innerHTML = renderAlertResult(result);
  } else {
    div.innerHTML = `<pre style="font-size:11px;color:var(--text2);white-space:pre-wrap">${esc(JSON.stringify(result, null, 2))}</pre>`;
  }

  // Append into .card-body so collapse animation covers it too
  const target = card.querySelector(".card-body") || card;
  target.appendChild(div);
  chainEl.scrollTop = chainEl.scrollHeight;
}
// ══════════════════════════════════════════════════════════════════
//  MARKDOWN RENDERER  (no external deps)
// ══════════════════════════════════════════════════════════════════
function renderMarkdown(text) {
  // Escape HTML first on raw text, then apply markdown
  let s = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Code spans (before bold/italic)
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Headers — most hashes first so #### doesn't get caught by ###
  s = s.replace(/^#{4,} (.+)$/gm, "<h4>$1</h4>");
  s = s.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  s = s.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^# (.+)$/gm, "<h3>$1</h3>");

  // Bold + italic
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
  s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Bullet lists — collect consecutive bullet lines into <ul>
  s = s.replace(/((?:^[-*] .+\n?)+)/gm, (match) => {
    const items = match
      .trim()
      .split("\n")
      .map((l) => `<li>${l.replace(/^[-*] /, "").trim()}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  });

  // Numbered lists
  s = s.replace(/((?:^\d+\. .+\n?)+)/gm, (match) => {
    const items = match
      .trim()
      .split("\n")
      .map((l) => `<li>${l.replace(/^\d+\. /, "").trim()}</li>`)
      .join("");
    return `<ol>${items}</ol>`;
  });

  // Paragraphs: split on blank lines, wrap non-block lines
  const blocks = s.split(/\n{2,}/);
  s = blocks
    .map((block) => {
      block = block.trim();
      if (!block) return "";
      if (/^<(h[1-6]|ul|ol|li|blockquote)/.test(block)) return block;
      return `<p>${block.replace(/\n/g, " ")}</p>`;
    })
    .join("\n");

  return s;
}

// ══════════════════════════════════════════════════════════════════
//  ALERTS UI
// ══════════════════════════════════════════════════════════════════
async function loadAlerts() {
  const { alerts = {} } = await chrome.storage.local.get("alerts");
  const list = Object.values(alerts);
  alertCount.textContent = list.length;
  if (!list.length) {
    alertsPanel.classList.add("hidden");
    return;
  }
  alertsPanel.classList.remove("hidden");
  alertsList.innerHTML = list
    .map((a) => {
      const sym = a.currency === "INR" ? "₹" : "$";
      return `
      <div class="alert-card">
        <div class="alert-card-name">${esc(a.productName.slice(0, 60))}…</div>
        <div class="alert-card-row" style="margin-bottom:6px">
          <div>
            <span class="alert-target">${sym}${a.thresholdPrice.toLocaleString()}</span>
            <span class="alert-current"> / current ${sym}${(a.lastPrice || 0).toLocaleString()}</span>
          </div>
        </div>
        <div class="alert-card-row">
          <span class="alert-status-pill ${a.triggered ? "pill-triggered" : "pill-watching"}">${a.triggered ? "✅ Triggered" : "👁 Watching"}</span>
          <button class="btn-remove" data-id="${a.id}">Remove</button>
        </div>
      </div>`;
    })
    .join("");

  alertsList.querySelectorAll(".btn-remove").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.currentTarget.dataset.id;
      const { alerts = {} } = await chrome.storage.local.get("alerts");
      delete alerts[id];
      await chrome.storage.local.set({ alerts });
      await chrome.runtime.sendMessage({ action: "CLEAR_ALARM", alertId: id });
      loadAlerts();
    });
  });
}

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════
async function apiFetch(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || `API error ${res.status}`);
  }
  return res.json();
}

function setStatus(msg) {
  statusText.textContent = msg;
  if (msg === "Done" || msg === "Ready") statusText.className = "sb-status";
}

function flash(msg) {
  const orig = statusText.textContent;
  const origClass = statusText.className;
  statusText.textContent = msg;
  statusText.className = "sb-status error";
  setTimeout(() => {
    statusText.textContent = orig;
    statusText.className = origClass;
  }, 2000);
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncUrl(u) {
  try {
    const { hostname, pathname } = new URL(u);
    const p = pathname.length > 28 ? pathname.slice(0, 28) + "…" : pathname;
    return `<span style="color:var(--text3)">${esc(hostname)}</span>${esc(p)}`;
  } catch {
    return esc(u.slice(0, 60));
  }
}
