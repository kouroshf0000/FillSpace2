"use strict";

(async function initAuthPages() {
  const body = document.body;
  const role = body.dataset.authRole;
  if (!role || (role !== "owner" && role !== "tenant")) {
    return;
  }

  const dashboardPath = role === "owner" ? "dashboard-owner.html" : "dashboard-tenant.html";
  const params = new URLSearchParams(window.location.search);
  const loginForm = document.getElementById("login-form");
  const registerForm = document.getElementById("register-form");
  const authMessage = document.getElementById("auth-message");
  const tabButtons = Array.from(document.querySelectorAll("[data-auth-tab]"));

  const setMessage = (text, isError = false) => {
    if (!(authMessage instanceof HTMLElement)) {
      return;
    }
    authMessage.textContent = text;
    authMessage.classList.toggle("is-error", isError);
  };

  const setActiveTab = (tabName) => {
    const showLogin = tabName === "login";
    if (loginForm instanceof HTMLElement) {
      loginForm.classList.toggle("is-hidden", !showLogin);
    }
    if (registerForm instanceof HTMLElement) {
      registerForm.classList.toggle("is-hidden", showLogin);
    }
    tabButtons.forEach((button) => {
      const isActive = button.dataset.authTab === tabName;
      button.classList.toggle("btn-primary", isActive);
      button.classList.toggle("btn-secondary", !isActive);
    });
    setMessage("");
  };

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setActiveTab(button.dataset.authTab || "login");
    });
  });

  try {
    const meRes = await fetch("/api/auth/me");
    if (meRes.ok) {
      const payload = await meRes.json();
      if (payload?.user?.role === role) {
        window.location.href = dashboardPath;
        return;
      }
    }
  } catch {
    // Ignore transient auth check issues on startup.
  }

  if (loginForm instanceof HTMLFormElement) {
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(loginForm);
      const payload = {
        email: String(formData.get("email") || "").trim(),
        password: String(formData.get("password") || ""),
        role,
      };
      setMessage("Signing in...");
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setMessage(data.error || "Unable to sign in.", true);
          return;
        }
        setMessage("Login successful. Redirecting...");
        window.location.href = dashboardPath;
      } catch {
        setMessage("Unable to reach the server. Start the app with npm run dev.", true);
      }
    });
  }

  if (registerForm instanceof HTMLFormElement) {
    registerForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(registerForm);
      const payload = {
        role,
        name: String(formData.get("name") || "").trim(),
        company: String(formData.get("company") || "").trim(),
        email: String(formData.get("email") || "").trim(),
        password: String(formData.get("password") || ""),
      };
      setMessage("Creating account...");
      try {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setMessage(data.error || "Unable to create account.", true);
          return;
        }
        setMessage("Account created. Redirecting...");
        window.location.href = dashboardPath;
      } catch {
        setMessage("Unable to reach the server. Start the app with npm run dev.", true);
      }
    });
  }

  setActiveTab("login");

  if (window.location.protocol === "file:") {
    setMessage("Open this app at http://localhost:4173 (not file://). Run: npm run dev", true);
    return;
  }

  if (params.get("error") === "offline") {
    setMessage("Server is offline. Start it with npm run dev, then refresh this page.", true);
  }
})();

