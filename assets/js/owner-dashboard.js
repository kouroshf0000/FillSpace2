"use strict";

const ownerState = {
  editingPropertyId: null,
  properties: [],
};

(async function initOwnerDashboard() {
  let authRes;
  try {
    authRes = await fetch("/api/auth/me");
  } catch {
    window.location.href = "owner-login.html?error=offline";
    return;
  }
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

  wireMobileMenu();
  wireDashboardNav();
  wireLogout();
  wireConnectStripe();
  wirePropertyForm();
  wirePropertyTableActions();
  setPropertyFormMode(null);
  handleStripeReturnState();

  await loadAllDashboardData();
})();

function wireMobileMenu() {
  const nav = document.querySelector(".site-nav");
  const menuToggle = document.querySelector(".menu-toggle");
  if (!(nav instanceof HTMLElement) || !(menuToggle instanceof HTMLButtonElement)) {
    return;
  }

  const setMenuState = (isOpen) => {
    nav.classList.toggle("open", isOpen);
    menuToggle.setAttribute("aria-expanded", String(isOpen));
    document.body.classList.toggle("menu-open", isOpen);
  };

  menuToggle.addEventListener("click", () => {
    const willOpen = !nav.classList.contains("open");
    setMenuState(willOpen);
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      setMenuState(false);
    });
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      !target.closest(".site-nav") &&
      !target.closest(".menu-toggle") &&
      nav.classList.contains("open")
    ) {
      setMenuState(false);
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 860 && nav.classList.contains("open")) {
      setMenuState(false);
    }
  });
}

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

function handleStripeReturnState() {
  const params = new URLSearchParams(window.location.search);
  const stripeState = String(params.get("stripe") || "");
  if (!stripeState) {
    return;
  }
  const message = document.getElementById("owner-property-message");
  if (stripeState === "connected") {
    setDashboardMessage(message, "Stripe onboarding complete. Your payouts are now ready.");
  } else if (stripeState === "refresh") {
    setDashboardMessage(message, "Stripe onboarding was interrupted. You can reconnect at any time.");
  }
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
        alert(
          friendlyErrorMessage(
            payload.error,
            "We couldn't start payout setup right now. Please try again in a moment."
          )
        );
        return;
      }
      if (payload.onboarding_url) {
        window.location.href = payload.onboarding_url;
      }
    } catch {
      alert("We couldn't reach Stripe setup right now. Please try again.");
    } finally {
      button.disabled = false;
      button.textContent = "Connect Stripe";
    }
  });
}

function wirePropertyForm() {
  const form = document.getElementById("owner-property-form");
  const message = document.getElementById("owner-property-message");
  const cancelEditButton = document.getElementById("owner-property-cancel");
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  if (cancelEditButton instanceof HTMLButtonElement) {
    cancelEditButton.addEventListener("click", () => {
      resetPropertyForm(form);
      setPropertyFormMode(null);
      setDashboardMessage(message, "Edit cancelled.");
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = formPayloadFromData(formData);
    const submitButton = document.getElementById("owner-property-submit");
    const isEditing = Number.isFinite(ownerState.editingPropertyId);
    const editingProperty = isEditing
      ? ownerState.properties.find((item) => item.id === ownerState.editingPropertyId)
      : null;

    // New listings should publish instantly in browse.
    payload.status = editingProperty?.status || "active";

    if (payload.max_term_months < payload.min_term_months) {
      setDashboardMessage(message, "Maximum term must be the same as or longer than minimum term.", true);
      return;
    }

    const endpoint = isEditing
      ? `/api/owner/properties/${ownerState.editingPropertyId}`
      : "/api/owner/properties";
    const method = isEditing ? "PUT" : "POST";

    setDashboardMessage(message, isEditing ? "Saving property updates..." : "Saving listing...");
    if (submitButton instanceof HTMLButtonElement) {
      submitButton.disabled = true;
    }
    try {
      const res = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setDashboardMessage(
          message,
          friendlyErrorMessage(data.error, "We couldn't save this listing. Please try again."),
          true
        );
        return;
      }

      resetPropertyForm(form);
      setPropertyFormMode(null);
      setDashboardMessage(
        message,
        isEditing
          ? "Property updated. Browse listings reflect the latest changes."
          : "Property added. It is now available in browse results."
      );
      await loadAllDashboardData();
    } catch {
      setDashboardMessage(message, "We couldn't reach the server. Please try again.", true);
    } finally {
      if (submitButton instanceof HTMLButtonElement) {
        submitButton.disabled = false;
      }
    }
  });
}

function wirePropertyTableActions() {
  const tbody = document.querySelector("#owner-properties-table tbody");
  const form = document.getElementById("owner-property-form");
  const message = document.getElementById("owner-property-message");
  if (!(tbody instanceof HTMLElement) || !(form instanceof HTMLFormElement)) {
    return;
  }

  tbody.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const actionButton = target.closest("[data-owner-action]");
    if (!(actionButton instanceof HTMLButtonElement)) {
      return;
    }

    const action = String(actionButton.dataset.ownerAction || "");
    const propertyId = Number(actionButton.dataset.propertyId);
    if (!Number.isFinite(propertyId)) {
      return;
    }

    if (action === "edit") {
      const property = ownerState.properties.find((item) => item.id === propertyId);
      if (!property) {
        setDashboardMessage(message, "Property not found for edit.", true);
        return;
      }
      fillPropertyForm(form, property);
      setPropertyFormMode(property.id);
      setDashboardMessage(message, `Editing ${property.title}.`);
      form.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    if (action === "toggle-status") {
      const property = ownerState.properties.find((item) => item.id === propertyId);
      if (!property) {
        return;
      }
      const nextStatus = property.status === "active" ? "paused" : "active";
      setDashboardMessage(message, `Updating ${property.title} status...`);
      try {
        const res = await fetch(`/api/owner/properties/${propertyId}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setDashboardMessage(
            message,
            friendlyErrorMessage(data.error, "We couldn't update this listing right now."),
            true
          );
          return;
        }
        setDashboardMessage(message, `${property.title} is now ${nextStatus}.`);
        await loadAllDashboardData();
      } catch {
        setDashboardMessage(message, "We couldn't reach the server. Please try again.", true);
      }
      return;
    }

    if (action === "delete") {
      const property = ownerState.properties.find((item) => item.id === propertyId);
      if (!property) {
        return;
      }
      const confirmed = window.confirm(
        `Delete "${property.title}"? Existing reservations will block deletion.`
      );
      if (!confirmed) {
        return;
      }

      setDashboardMessage(message, `Deleting ${property.title}...`);
      try {
        const res = await fetch(`/api/owner/properties/${propertyId}`, {
          method: "DELETE",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setDashboardMessage(
            message,
            friendlyErrorMessage(data.error, "We couldn't delete this listing right now."),
            true
          );
          return;
        }

        if (ownerState.editingPropertyId === propertyId) {
          resetPropertyForm(form);
          setPropertyFormMode(null);
        }
        setDashboardMessage(message, `${property.title} deleted.`);
        await loadAllDashboardData();
      } catch {
        setDashboardMessage(message, "We couldn't reach the server. Please try again.", true);
      }
    }
  });
}

function formPayloadFromData(formData) {
  return {
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
    best_for: formData.getAll("best_for").filter(Boolean).join(", "),
    status: String(formData.get("status") || "active"),
    utilities: String(formData.get("utilities") || "").trim(),
    buildout: String(formData.get("buildout") || "").trim(),
    description: String(formData.get("description") || "").trim(),
    amenities: formData.getAll("amenities").filter(Boolean),
  };
}

function fillPropertyForm(form, property) {
  const setField = (name, value) => {
    const node = form.elements.namedItem(name);
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
      node.value = String(value ?? "");
    }
  };

  setField("property_id", property.id);
  setField("title", property.title);
  setField("location", property.location);
  setField("city", property.city);
  setField("state", property.state);
  setField("size_sqft", property.size_sqft);
  setField("monthly_price", property.monthly_price);
  setField("min_term_months", property.min_term_months);
  setField("max_term_months", property.max_term_months);
  setField("availability_text", property.availability_text);
  setField("image_url", property.image_url);
  setField("status", property.status);
  setField("utilities", property.utilities);
  setField("buildout", property.buildout);
  setField("description", property.description);

  const amenitySet = new Set(Array.isArray(property.amenities) ? property.amenities : []);
  form.querySelectorAll('input[name="amenities"]').forEach((cb) => {
    if (cb instanceof HTMLInputElement) cb.checked = amenitySet.has(cb.value);
  });

  const bestForSet = new Set(String(property.best_for || "").split(",").map((s) => s.trim()).filter(Boolean));
  form.querySelectorAll('input[name="best_for"]').forEach((cb) => {
    if (cb instanceof HTMLInputElement) cb.checked = bestForSet.has(cb.value);
  });
}

function resetPropertyForm(form) {
  form.reset();
  const propertyIdField = form.elements.namedItem("property_id");
  if (propertyIdField instanceof HTMLInputElement) {
    propertyIdField.value = "";
  }
}

function setPropertyFormMode(propertyId) {
  const numericId = Number(propertyId);
  ownerState.editingPropertyId = Number.isInteger(numericId) && numericId > 0 ? numericId : null;

  const submitButton = document.getElementById("owner-property-submit");
  const cancelButton = document.getElementById("owner-property-cancel");
  if (submitButton instanceof HTMLButtonElement) {
    submitButton.textContent = ownerState.editingPropertyId ? "Save changes" : "Add property";
  }
  if (cancelButton instanceof HTMLButtonElement) {
    cancelButton.classList.toggle("is-hidden", !ownerState.editingPropertyId);
  }
}

function setDashboardMessage(node, text, isError = false) {
  if (!(node instanceof HTMLElement)) {
    return;
  }
  node.textContent = text;
  node.classList.toggle("is-error", isError);
}

function notifyDashboardError(text) {
  const node = document.getElementById("owner-property-message");
  setDashboardMessage(node, text, true);
}

async function loadAllDashboardData() {
  const results = await Promise.allSettled([
    loadOwnerOverview(),
    loadOwnerProperties(),
    loadOwnerAnalytics(),
    loadOwnerFinance(),
    loadOwnerInquiries(),
    loadOwnerLegal(),
  ]);
  if (results.some((result) => result.status === "rejected")) {
    notifyDashboardError("Some dashboard data could not be loaded. Please refresh.");
  }
}

async function loadOwnerOverview() {
  const [dashboardRes, analyticsRes] = await Promise.all([
    fetch("/api/owner/dashboard"),
    fetch("/api/owner/analytics"),
  ]);
  if (!dashboardRes.ok || !analyticsRes.ok) {
    notifyDashboardError("Unable to load owner overview right now.");
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
  const connectStripeBtn = document.getElementById("connect-stripe-btn");
  const propertySubmitBtn = document.getElementById("owner-property-submit");
  const dashboardMessage = document.getElementById("owner-property-message");
  const stripeDetails = dashboard?.stripe_status || {};
  if (stripeStatus) {
    if (!stripeDetails.connected) {
      stripeStatus.textContent = "Stripe not connected";
    } else if (stripeDetails.ready) {
      stripeStatus.textContent = "Stripe connected";
    } else {
      stripeStatus.textContent = "Stripe onboarding incomplete";
    }
  }
  if (connectStripeBtn instanceof HTMLButtonElement) {
    if (!stripeDetails.connected) {
      connectStripeBtn.textContent = "Connect Stripe";
    } else if (stripeDetails.ready) {
      connectStripeBtn.textContent = "Stripe Connected";
    } else {
      connectStripeBtn.textContent = "Continue Stripe onboarding";
    }
  }
  if (propertySubmitBtn instanceof HTMLButtonElement) {
    propertySubmitBtn.disabled = Boolean(!stripeDetails.ready);
  }
  if (!stripeDetails.ready && dashboardMessage instanceof HTMLElement) {
    setDashboardMessage(
      dashboardMessage,
      dashboard.stripe_message || "Finish Stripe onboarding before listing properties.",
      true
    );
  }
}

async function loadOwnerProperties() {
  const res = await fetch("/api/owner/properties");
  if (!res.ok) {
    notifyDashboardError("Unable to load your properties.");
    return;
  }
  const payload = await res.json();
  ownerState.properties = payload.properties || [];
  const tbody = document.querySelector("#owner-properties-table tbody");
  if (!(tbody instanceof HTMLElement)) {
    return;
  }
  tbody.innerHTML = "";

  for (const property of ownerState.properties) {
    const statusLabel = formatStatus(property.status);
    const toggleLabel = property.status === "active" ? "Pause" : "Activate";
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${escapeHtml(property.title)}</td>
      <td>${statusBadge(property.status)}</td>
      <td>${formatCurrency(property.monthly_price)}</td>
      <td>${property.min_term_months}-${property.max_term_months} months</td>
      <td>
        <div class="property-row-actions">
          <button class="table-action-btn" type="button" data-owner-action="edit" data-property-id="${property.id}">
            Edit
          </button>
          <button class="table-action-btn" type="button" data-owner-action="toggle-status" data-property-id="${property.id}">
            ${toggleLabel}
          </button>
          <button class="table-action-btn danger" type="button" data-owner-action="delete" data-property-id="${property.id}">
            Delete
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(row);
  }

  if (!tbody.children.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="5">No properties yet.</td>`;
    tbody.appendChild(row);
  }
  applyResponsiveTableLabels("#owner-properties-table");
}

async function loadOwnerAnalytics() {
  const res = await fetch("/api/owner/analytics");
  if (!res.ok) {
    notifyDashboardError("Unable to load analytics.");
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
  applyResponsiveTableLabels("#owner-analytics-table");
}

async function loadOwnerFinance() {
  const res = await fetch("/api/owner/finance");
  if (!res.ok) {
    notifyDashboardError("Unable to load finance transactions.");
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
      <td>${statusBadge(tx.status)}</td>
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
  applyResponsiveTableLabels("#owner-finance-table");
}

async function loadOwnerLegal() {
  const res = await fetch("/api/owner/legal");
  if (!res.ok) {
    notifyDashboardError("Unable to load tax and legal resources.");
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

  try {
    const taxRes = await fetch("/api/owner/tax/1099-summary");
    if (!taxRes.ok) {
      return;
    }
    const tax = await taxRes.json();
    const csvLink = document.createElement("a");
    csvLink.href = `/api/owner/tax/1099.csv?year=${encodeURIComponent(tax.year)}`;
    csvLink.textContent = `Download ${tax.year} 1099 CSV (${tax.reservation_count} confirmed bookings)`;
    csvLink.className = "inline-link";
    const wrapper = document.createElement("li");
    wrapper.appendChild(csvLink);
    list.appendChild(wrapper);
  } catch {
    // Tax summary is optional if endpoint is unavailable.
  }
}

async function loadOwnerInquiries() {
  const res = await fetch("/api/owner/inquiries");
  if (!res.ok) {
    notifyDashboardError("Unable to load inquiry inbox.");
    return;
  }
  const payload = await res.json();
  const tbody = document.querySelector("#owner-inquiries-table tbody");
  if (!(tbody instanceof HTMLElement)) {
    return;
  }
  tbody.innerHTML = "";

  for (const inquiry of payload.inquiries || []) {
    const row = document.createElement("tr");
    const created = escapeHtml(String(inquiry.created_at || "").slice(0, 16).replace("T", " "));
    const goal = escapeHtml(String(inquiry.goal || ""));
    const source = escapeHtml(String(inquiry.source || ""));
    const message = escapeHtml(String(inquiry.message || ""));
    const shortenedMessage = message.length > 120 ? `${message.slice(0, 117)}...` : message;
    row.innerHTML = `
      <td>${created}</td>
      <td>${escapeHtml(inquiry.name || "")}</td>
      <td>${escapeHtml(inquiry.email || "")}</td>
      <td>${goal}</td>
      <td>${source}</td>
      <td>${shortenedMessage}</td>
    `;
    tbody.appendChild(row);
  }

  if (!tbody.children.length) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="6">No inquiries yet.</td>`;
    tbody.appendChild(row);
  }
  applyResponsiveTableLabels("#owner-inquiries-table");
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

function formatStatus(status) {
  const raw = String(status || "").trim();
  if (!raw) {
    return "Unknown";
  }
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function statusBadge(status) {
  const raw = String(status || "").toLowerCase().replace(/_/g, "-");
  const label = String(status || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return `<span class="status-badge is-${escapeHtml(raw)}">${escapeHtml(label)}</span>`;
}

function friendlyErrorMessage(rawMessage, fallbackMessage) {
  const message = String(rawMessage || "").trim();
  if (!message) {
    return fallbackMessage;
  }
  const lower = message.toLowerCase();
  if (
    lower.includes("invalid payload") ||
    lower.includes("invalid input") ||
    lower.includes("expected ") ||
    lower.includes("api route")
  ) {
    return fallbackMessage;
  }
  return message;
}

function applyResponsiveTableLabels(selector) {
  const table = document.querySelector(selector);
  if (!(table instanceof HTMLTableElement)) {
    return;
  }
  const headers = Array.from(table.querySelectorAll("thead th")).map((node) =>
    String(node.textContent || "").trim()
  );
  table.querySelectorAll("tbody tr").forEach((row) => {
    const cells = Array.from(row.children).filter((cell) => cell instanceof HTMLTableCellElement);
    cells.forEach((cell, index) => {
      if (!(cell instanceof HTMLTableCellElement)) {
        return;
      }
      if (cell.hasAttribute("colspan")) {
        cell.removeAttribute("data-label");
        return;
      }
      cell.dataset.label = headers[index] || "";
    });
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

