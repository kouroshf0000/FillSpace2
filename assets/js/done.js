"use strict";

initialize();

async function initialize() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = String(params.get("session_id") || "").trim();
  const accountIdFromQuery = String(params.get("accountId") || "").trim();
  const accountId = accountIdFromQuery || String(localStorage.getItem("accountId") || "").trim();

  if (accountId) {
    localStorage.setItem("accountId", accountId);
  }

  const successNode = document.getElementById("success");
  if (successNode instanceof HTMLElement && sessionId) {
    successNode.textContent = `Your payment was successful. Session: ${sessionId}`;
  }

  const dashboardAnchor = document.getElementById("dashboard");
  if (!(dashboardAnchor instanceof HTMLAnchorElement)) {
    return;
  }
  if (!accountId) {
    dashboardAnchor.classList.add("hidden");
    return;
  }

  try {
    const response = await fetch(`/api/account-login-link/${encodeURIComponent(accountId)}`);
    if (!response.ok) {
      throw new Error("Failed to create login link");
    }
    const payload = await response.json();
    dashboardAnchor.href = payload.url || "#";
  } catch {
    dashboardAnchor.href = "connect.html";
    dashboardAnchor.textContent = "Back to Connect dashboard";
    dashboardAnchor.removeAttribute("target");
    dashboardAnchor.removeAttribute("rel");
  }
}
