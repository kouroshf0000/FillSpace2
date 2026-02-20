"use strict";

(function initAdminLogin() {
  const form = document.getElementById("admin-login-form");
  const message = document.getElementById("admin-login-message");
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = String(document.getElementById("admin-email")?.value || "").trim();
    const password = String(document.getElementById("admin-password")?.value || "");
    if (!email || !password) {
      setMessage(message, "Please enter email and password.", true);
      return;
    }
    setMessage(message, "Signing in...");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, role: "admin" }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(message, payload.error || "Unable to sign in.", true);
        return;
      }
      window.location.href = "admin-dashboard.html";
    } catch {
      setMessage(message, "Unable to reach the server.", true);
    }
  });
})();

function setMessage(node, text, isError = false) {
  if (!(node instanceof HTMLElement)) {
    return;
  }
  node.textContent = text;
  node.classList.toggle("is-error", isError);
}
