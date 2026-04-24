// content.js — Smart Cart scraper
// Runs on Amazon & Flipkart product pages

(function () {
  "use strict";

  function scrapeAmazon() {
    const titleEl =
      document.querySelector("#productTitle") ||
      document.querySelector(".product-title-word-break") ||
      document.querySelector("h1.a-size-large");

    const priceEl =
      document.querySelector(".a-price-whole") ||
      document.querySelector("#priceblock_ourprice") ||
      document.querySelector("#priceblock_dealprice") ||
      document.querySelector(".apexPriceToPay .a-price-whole") ||
      document.querySelector("#apex_offerDisplay_desktop .a-price-whole") ||
      document.querySelector(".priceToPay .a-price-whole");

    const ratingEl =
      document.querySelector("#acrPopover") ||
      document.querySelector(".a-icon-alt");

    const reviewEl = document.querySelector("#acrCustomerReviewText");

    const title = titleEl ? titleEl.textContent.trim() : null;
    let price = null;
    if (priceEl) {
      const raw = priceEl.textContent.replace(/[^0-9]/g, "");
      price = raw ? parseInt(raw, 10) : null;
    }

    const rating = ratingEl
      ? parseFloat(ratingEl.getAttribute("title") || ratingEl.textContent)
      : null;

    const reviews = reviewEl
      ? reviewEl.textContent.trim()
      : null;

    return {
      success: !!(title && price),
      store: "Amazon",
      title,
      price,
      currency: window.location.hostname.includes(".in") ? "INR" : "USD",
      rating,
      reviews,
      url: window.location.href
    };
  }

  function scrapeFlipkart() {
    const titleEl =
      document.querySelector(".B_NuCI") ||
      document.querySelector("h1.yhB1nd") ||
      document.querySelector("._35KyD6") ||
      document.querySelector("span.B_NuCI");

    const priceEl =
      document.querySelector("._30jeq3._16Jk6d") ||
      document.querySelector("._30jeq3") ||
      document.querySelector(".Nx9bqj.CxhGGd") ||
      document.querySelector(".Nx9bqj");

    const ratingEl =
      document.querySelector("._3LWZlK") ||
      document.querySelector(".ipqd2A");

    const title = titleEl ? titleEl.textContent.trim() : null;
    let price = null;
    if (priceEl) {
      const raw = priceEl.textContent.replace(/[^0-9]/g, "");
      price = raw ? parseInt(raw, 10) : null;
    }

    const rating = ratingEl ? parseFloat(ratingEl.textContent) : null;

    return {
      success: !!(title && price),
      store: "Flipkart",
      title,
      price,
      currency: "INR",
      rating,
      url: window.location.href
    };
  }

  // Listen for scrape requests from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "SCRAPE_PRODUCT") {
      try {
        const url = window.location.href;
        let result;
        if (url.includes("amazon")) {
          result = scrapeAmazon();
        } else if (url.includes("flipkart")) {
          result = scrapeFlipkart();
        } else {
          result = { success: false, error: "Not a supported store" };
        }
        sendResponse(result);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    }
    return true; // keep channel open for async
  });
})();
