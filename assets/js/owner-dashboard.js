"use strict";

(async function initOwnerDashboard() {
  const authRes = await fetch("/api/auth/me");
  if (!authRes.ok) {
    window.location.href = "owner-login.html";
    return;
  }
  const authPayload = await authRes.json();
  const user = authPayload.user;
  if (!user || user.role !== "owner") {
    window.location.href = user?.role === "tenant" ? "dashboard-tenant.html" : "owner-login.html";
    return;
  }

  const ownerName = document.getElementById("owner-name");
  const ownerCompany = document.getElementById("owner-company");
  if (ownerName) ownerName.textContent = user.name;
  if (ownerCompany) ownerCompany.textContent = user.company || user.email;

  wireDashboardNav();
  wireLogout();
  wireConnectStripe();
  wirePropertyCreate();

  await loadAllDashboardData();
})();

function wireDashboardNav() {
  const navButtons = Array.from(document.querySelectorAll("[data-dash-target]"));
  const panels = Array.from(document.querySelectorAll(".dashboard-panel"));

  const activatePanel = (panelId) => {
    navButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.dashTarget === panelId);
    });
    panels.forEach((panel) => {
      panel.classList.toggle("active", panel.id === panelId);
    });
  };

  navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      activatePanel(button.dataset.dashTarget || "");
    });
  });
}

function wireLogout() {
  const button = document.getElementById("owner-logout-btn");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  button.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "owner-login.html";
  });
}

function wireConnectStripe() {
  const button = document.getElementById("connect-stripe-btn");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Connecting...";
    try {
      const res = await fetch("/api/owner/stripe/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const payload = await res.json();
      if (!res.ok) {
        alert(payload.error || "Unable to start Stripe onboarding.");
        return;
      }
      if (payload.onboarding_url) {
        window.location.href = payload.onboarding_url;
      }
    } finally {
      button.disabled = false;
      button.textContent = "Connect Stripe";
    }
  });
}

function wirePropertyCreate() {
  const form = document.getElementById("owner-property-form");
  const message = document.getElementById("owner-property-message");
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const amenitiesRaw = String(formData.get("amenities") || "");
    const payload = {
      title: String(formData.get("title") || "").trim(),
      location: String(formData.get("location") || "").trim(),
      city: String(formData.get("city") || "").trim(),
      state: String(formData.get("state") || "").trim(),
      size_sqft: Number(formData.get("size_sqft") || 0),
      monthly_price: Number(formData.get("monthly_price") || 0),
      min_term_months: Number(formData.get("min_term_months") || 0),
      max_term_months: Number(formData.get("max_term_months") || 0),
      availability_text: String(formData.get("availability_text") || "").trim(),
      image_url: String(formData.get("image_url") || "").trim(),
      best_for: String(formData.get("best_for") || "").trim(),
      status: String(formData.get("status") || "active"),
      utilities: String(formData.get("utilities") || "").trim(),
      buildout: String(formData.get("buildout") || "").trim(),
      description: String(formData.get("description") || "").trim(),
      amenities: amenitiesRaw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    };

    setDashboardMessage(message, "Saving listing...");
    const res = await fetch("/api/owner/properties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      setDashboardMessage(message, data.error || "Could not save listing.", true);
      return;
    }

    form.reset();
    setDashboardMessage(message, "Property added. It is now available in browse results.");
    await loadAllDashboardData();
  });
}

function setDashboardMessage(node, text, isError = false) {
  if (!(node instanceof HTMLElement)) {
    return;
  }
  node.textContent = text;
  node.classList.toggle("is-error", isError);
}

async function loadAllDashboardData() {
  await Promise.all([
    loadOwnerOverview(),
    loadOwnerProperties(),
    loadOwnerAnalytics(),
    loadOwnerFinance(),
    loadOwnerLegal(),
  ]);
}

async function loadOwnerOverview() {
  const dashboardRes = await fetch("/api/owner/dashboard");
  const analyticsRes = await fetch("/api/owner/analytics");
  if (!dashboardRes.ok || !analyticsRes.ok) {
    return;
  }
  const dashboard = await dashboardRes.json();
  const analytics = await analyticsRes.json();

  setText("metric-total-properties", String(analytics.summary.total_properties || 0));
  setText("metric-active-properties", String(analytics.summary.active_properties || 0));
  setText("metric-total-reservations", String(analytics.summary.total_reservations || 0));
  setText("metric-confirmed-reservations", String(analytics.summary.confirmed_reservations || 0));
  setText("metric-gross-revenue", formatCurrency(analytics.summary.gross_revenue || 0));
  setText("metric-owner-payout", formatCurrency(analytics.summary.owner_payouts || 0));

  const stripeStatus = document.getElementById("owner-stripe-status");
  if (stripeStatus) {
    stripeStatus.textContent = dashboard.stripe_connected ? "Stripe connected" : "Stripe not connected";
  }
}

async function loadOwnerProperties() {
  const res = await fetch("/api/owner/properties");
  if (!res.ok) {
    return;
  }
  const payload = await res.json();
  const tbody = document.querySelector("#owner-properties-table tbody");
  if (!(tbody instanceof HTMLElement)) {
    return;
  }
  tbody.innerHTML = "";

  for (const property of payload.properties || []) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(property.title)}</td>
      <td>${escapeHtml(property.status)}</td>
      <td>${formatCurrency(property.monthly_price)}</td>
      <td>${property.min_term_months}-${property.max_term_months} months</td>
    `;
    tbody.appendChild(row);
  }

  if (!tbody.children.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="4">No properties yet.</td>`;
    tbody.appendChild(row);
  }
}

async function loadOwnerAnalytics() {
  const res = await fetch("/api/owner/analytics");
  if (!res.ok) {
    return;
  }
  const payload = await res.json();
  const tbody = document.querySelector("#owner-analytics-table tbody");
  if (!(tbody instanceof HTMLElement)) {
    return;
  }
  tbody.innerHTML = "";

  for (const item of payload.property_performance || []) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(item.title)}</td>
      <td>${formatCurrency(item.monthly_price)}</td>
      <td>${item.reservation_count || 0}</td>
      <td>${formatCurrency(item.revenue || 0)}</td>
    `;
    tbody.appendChild(row);
  }

  if (!tbody.children.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="4">No analytics yet.</td>`;
    tbody.appendChild(row);
  }
}

async function loadOwnerFinance() {
  const res = await fetch("/api/owner/finance");
  if (!res.ok) {
    return;
  }
  const payload = await res.json();
  const tbody = document.querySelector("#owner-finance-table tbody");
  if (!(tbody instanceof HTMLElement)) {
    return;
  }
  tbody.innerHTML = "";

  for (const tx of payload.transactions || []) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml((tx.created_at || "").slice(0, 10))}</td>
      <td>${escapeHtml(tx.property_title || "")}</td>
      <td>${escapeHtml(tx.status || "")}</td>
      <td>${formatCurrency(tx.total || 0)}</td>
      <td>${formatCurrency(tx.platform_fee || 0)}</td>
      <td>${formatCurrency(tx.owner_payout || 0)}</td>
    `;
    tbody.appendChild(row);
  }

  if (!tbody.children.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="6">No transactions yet.</td>`;
    tbody.appendChild(row);
  }
}

async function loadOwnerLegal() {
  const res = await fetch("/api/owner/legal");
  if (!res.ok) {
    return;
  }
  const payload = await res.json();
  const list = document.getElementById("owner-legal-list");
  if (!(list instanceof HTMLElement)) {
    return;
  }
  list.innerHTML = "";
  for (const doc of payload.documents || []) {
    const item = document.createElement("li");
    item.textContent = `${doc.name} (${doc.category}) · Updated ${doc.updated_at}`;
    list.appendChild(item);
  }
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) {
    node.textContent = value;
  }
}

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

