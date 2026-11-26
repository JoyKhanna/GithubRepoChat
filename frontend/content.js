/**
 * content.js — Injected on all github.com pages.
 * Responds to popup messages with the current tab URL.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "GET_GITHUB_URL") {
    sendResponse({ url: window.location.href });
  }
  return true; // Keep message channel open for async sendResponse
});
