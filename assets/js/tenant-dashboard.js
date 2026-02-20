"use strict";

const tenantState = {
  properties: [],
  favorites: [],
  reservationsUpcoming: [],
  reservationsHistory: [],
  financeRows: [],
  financeSummary: {
    reservation_count: 0,
    confirmed_total: 0,
    platform_fees: 0,
    tax_year: new Date().getFullYear(),
  },
};
const FALLBACK_PROPERTY_IMAGE =
  "https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1200&q=80";

(async function initTenantDashboard() {
  let authRes;
  try {
    authRes = await fetch("/api/auth/me");
  } catch {
    window.location.href = "tenant-login.html?error=offline";
    return;
  }
  if (!authRes.ok) {
    window.location.href = "tenant-login.html";
    return;
  }
  const authPayload = await authRes.json();
  const user = authPayload.user;
  if (!user || user.role !== "tenant") {
    window.location.href = user?.role === "owner" ? "dashboard-owner.html" : "tenant-login.html";
    return;
  }

  setText("tenant-name", user.name);
  setText("tenant-company", user.company || user.email);

  wireMobileMenu();
  wireDashboardNav();
  wireLogout();
  wireBookingForm();
  handleCheckoutReturnState();

  await loadAllTenantData();
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
    button.addEventListener("click", () => activatePanel(button.dataset.dashTarget || ""));
  });
}

function wireLogout() {
  const button = document.getElementById("tenant-logout-btn");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  button.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "tenant-login.html";
  });
}

function wireBookingForm() {
  const form = document.getElementById("tenant-booking-form");
  const propertySelect = document.getElementById("booking-property");
  const startInput = document.getElementById("booking-start");
  const endInput = document.getElementById("booking-end");
  const quoteText = document.getElementById("booking-quote-text");
  const message = document.getElementById("tenant-booking-message");

  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (startInput instanceof HTMLInputElement) {
    startInput.min = today;
  }
  if (endInput instanceof HTMLInputElement) {
    endInput.min = today;
  }

  const updateQuote = async () => {
    if (!(propertySelect instanceof HTMLSelectElement)) {
      return;
    }
    const propertyId = Number(propertySelect.value);
    const startDate = startInput instanceof HTMLInputElement ? startInput.value : "";
    const endDate = endInput instanceof HTMLInputElement ? endInput.value : "";
    if (!propertyId || !startDate || !endDate) {
      if (quoteText instanceof HTMLElement) {
        quoteText.textContent = "Select dates to preview pricing.";
      }
      return;
    }
    if (endDate <= startDate) {
      if (quoteText instanceof HTMLElement) {
        quoteText.textContent = "End date must be after start date.";
      }
      return;
    }
    const params = new URLSearchParams({
      propertyId: String(propertyId),
      startDate,
      endDate,
    });
    try {
      const res = await fetch(`/api/payments/quote?${params.toString()}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (quoteText instanceof HTMLElement) {
          quoteText.textContent = friendlyErrorMessage(
            payload.error,
            "We couldn't preview pricing for those dates."
          );
        }
        return;
      }
      if (quoteText instanceof HTMLElement) {
        const depositText =
          Number(payload.security_deposit || 0) > 0
            ? ` • security deposit ${formatCurrency(payload.security_deposit)}`
            : "";
        quoteText.textContent = `${payload.months} month(s): booking total ${formatCurrency(payload.total)}${depositText} • charged now ${formatCurrency(payload.charged_now || payload.total)} • platform fee ${formatCurrency(payload.platform_fee)}`;
      }
    } catch {
      if (quoteText instanceof HTMLElement) {
        quoteText.textContent = "We couldn't connect to the server to preview pricing.";
      }
    }
  };

  if (propertySelect instanceof HTMLSelectElement) {
    propertySelect.addEventListener("change", updateQuote);
  }
  if (startInput instanceof HTMLInputElement) {
    startInput.addEventListener("change", () => {
      if (endInput instanceof HTMLInputElement) {
        endInput.min = startInput.value || today;
      }
      updateQuote();
    });
  }
  if (endInput instanceof HTMLInputElement) {
    endInput.addEventListener("change", updateQuote);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!(propertySelect instanceof HTMLSelectElement)) {
      return;
    }
    const payload = {
      propertyId: Number(propertySelect.value),
      startDate: startInput instanceof HTMLInputElement ? startInput.value : "",
      endDate: endInput instanceof HTMLInputElement ? endInput.value : "",
    };
    if (!payload.propertyId || !payload.startDate || !payload.endDate) {
      setDashboardMessage(message, "Please choose a property and both dates.", true);
      return;
    }
    if (payload.endDate <= payload.startDate) {
      setDashboardMessage(message, "End date must be after start date.", true);
      return;
    }
    setDashboardMessage(message, "Creating Stripe checkout...");
    try {
      const res = await fetch("/api/payments/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDashboardMessage(
          message,
          friendlyErrorMessage(data.error, "We couldn't start checkout right now."),
          true
        );
        return;
      }
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
        return;
      }
      setDashboardMessage(message, "Checkout was created, but we couldn't open Stripe. Please try again.", true);
    } catch {
      setDashboardMessage(message, "We couldn't reach the server. Please try again.", true);
    }
  });
}

function handleCheckoutReturnState() {
  const params = new URLSearchParams(window.location.search);
  const checkoutState = String(params.get("checkout") || "");
  if (!checkoutState) {
    return;
  }
  const message = document.getElementById("tenant-booking-message");
  if (checkoutState === "success") {
    setDashboardMessage(message, "Stripe checkout completed. We are finalizing your reservation.");
  } else if (checkoutState === "cancelled") {
    setDashboardMessage(message, "Checkout was cancelled. You can try again anytime.", true);
  }
}

async function loadAllTenantData() {
  const results = await Promise.allSettled([loadProperties(), loadReservationsAndFinance(), loadFavorites()]);
  if (results.some((result) => result.status === "rejected")) {
    notifyTenantError("Some dashboard data could not be loaded. Please refresh.");
  }
  renderMetrics();
  renderFinanceSummary();
  renderBookingPropertyOptions();
  renderTenantBrowseGrid();
}

async function loadProperties() {
  const res = await fetch("/api/properties");
  if (!res.ok) {
    tenantState.properties = [];
    notifyTenantError("Unable to load properties for browsing.");
    return;
  }
  const payload = await res.json();
  tenantState.properties = payload.properties || [];
}

async function loadReservationsAndFinance() {
  const [resList, resDash] = await Promise.all([
    fetch("/api/tenant/reservations"),
    fetch("/api/tenant/dashboard"),
  ]);
  if (resList.ok) {
    const payload = await resList.json();
    tenantState.reservationsUpcoming = payload.upcoming || [];
    tenantState.reservationsHistory = payload.history || [];
  }
  if (!resList.ok) {
    notifyTenantError("Unable to load reservations.");
  }
  if (resDash.ok) {
    const payload = await resDash.json();
    tenantState.financeRows = payload.reservations || [];
    if (payload.finance) {
      tenantState.financeSummary = {
        reservation_count: payload.finance.reservation_count || 0,
        confirmed_total: payload.finance.confirmed_total || 0,
        platform_fees: payload.finance.platform_fees || 0,
        tax_year: payload.finance.tax_year || new Date().getFullYear(),
      };
    }
  }
  if (!resDash.ok) {
    notifyTenantError("Unable to load finance summary.");
  }
  renderReservationTables();
  renderFinanceTable();
  renderFinanceSummary();
}

async function loadFavorites() {
  const res = await fetch("/api/tenant/favorites");
  if (!res.ok) {
    tenantState.favorites = [];
    notifyTenantError("Unable to load your watchlist right now.");
  } else {
    const payload = await res.json();
    tenantState.favorites = payload.favorites || [];
  }
  renderFavorites();
}

function renderMetrics() {
  setText("tenant-metric-upcoming", String(tenantState.reservationsUpcoming.length));
  setText("tenant-metric-history", String(tenantState.reservationsHistory.length));
  setText("tenant-metric-favorites", String(tenantState.favorites.length));
  setText("tenant-metric-spend", formatCurrency(tenantState.financeSummary.confirmed_total || 0));
}

function renderFinanceSummary() {
  setText("tenant-tax-year", String(tenantState.financeSummary.tax_year || new Date().getFullYear()));
  setText("tenant-finance-res-count", String(tenantState.financeSummary.reservation_count || 0));
  setText("tenant-finance-confirmed", formatCurrency(tenantState.financeSummary.confirmed_total || 0));
  setText("tenant-finance-fees", formatCurrency(tenantState.financeSummary.platform_fees || 0));
}

function renderReservationTables() {
  const upcomingBody = document.querySelector("#tenant-upcoming-table tbody");
  const historyBody = document.querySelector("#tenant-history-table tbody");
  if (!(upcomingBody instanceof HTMLElement) || !(historyBody instanceof HTMLElement)) {
    return;
  }
  upcomingBody.innerHTML = "";
  historyBody.innerHTML = "";

  for (const row of tenantState.reservationsUpcoming) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.property_title)}</td>
      <td>${escapeHtml(row.start_date)} → ${escapeHtml(row.end_date)}</td>
      <td>${statusBadge(row.status)}</td>
      <td>${formatCurrency(row.total)}</td>
    `;
    upcomingBody.appendChild(tr);
  }

  if (!upcomingBody.children.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4">No upcoming reservations.</td>`;
    upcomingBody.appendChild(tr);
  }

  for (const row of tenantState.reservationsHistory) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.property_title)}</td>
      <td>${escapeHtml(row.start_date)} → ${escapeHtml(row.end_date)}</td>
      <td>${statusBadge(row.status)}</td>
      <td>${formatCurrency(row.total)}</td>
    `;
    historyBody.appendChild(tr);
  }

  if (!historyBody.children.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4">No reservation history yet.</td>`;
    historyBody.appendChild(tr);
  }
  applyResponsiveTableLabels("#tenant-upcoming-table");
  applyResponsiveTableLabels("#tenant-history-table");
}

function renderFavorites() {
  const grid = document.getElementById("tenant-favorites-grid");
  if (!(grid instanceof HTMLElement)) {
    return;
  }
  grid.innerHTML = "";
  for (const property of tenantState.favorites) {
    const card = createTenantPropertyCard(property, true);
    grid.appendChild(card);
  }
  if (!grid.children.length) {
    grid.innerHTML = `<p>You have no saved properties yet.</p>`;
  }
}

function renderFinanceTable() {
  const tbody = document.querySelector("#tenant-finance-table tbody");
  if (!(tbody instanceof HTMLElement)) {
    return;
  }
  tbody.innerHTML = "";
  for (const row of tenantState.financeRows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml((row.created_at || "").slice(0, 10))}</td>
      <td>${escapeHtml(row.property_title || "")}</td>
      <td>${statusBadge(row.status)}</td>
      <td>${formatCurrency(row.total || 0)}</td>
      <td>${formatCurrency(row.platform_fee || 0)}</td>
    `;
    tbody.appendChild(tr);
  }
  if (!tbody.children.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5">No transactions yet.</td>`;
    tbody.appendChild(tr);
  }
  applyResponsiveTableLabels("#tenant-finance-table");
}

function renderBookingPropertyOptions() {
  const select = document.getElementById("booking-property");
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }
  select.innerHTML = `<option value="">Select a property</option>`;
  for (const property of tenantState.properties) {
    const option = document.createElement("option");
    option.value = String(property.id);
    option.textContent = `${property.title} · ${formatCurrency(property.monthly_price)}/mo`;
    select.appendChild(option);
  }
}

function renderTenantBrowseGrid() {
  const grid = document.getElementById("tenant-browse-grid");
  if (!(grid instanceof HTMLElement)) {
    return;
  }
  grid.innerHTML = "";
  const favoriteSet = new Set(tenantState.favorites.map((property) => property.id));
  for (const property of tenantState.properties.slice(0, 12)) {
    const card = createTenantPropertyCard(property, favoriteSet.has(property.id));
    grid.appendChild(card);
  }
  if (!grid.children.length) {
    grid.innerHTML = `<p>No active properties are available yet.</p>`;
  }
}

function createTenantPropertyCard(property, isFavorite) {
  const card = document.createElement("article");
  card.className = "property-card";
  const imageSource = property.image_url || FALLBACK_PROPERTY_IMAGE;
  card.innerHTML = `
    <img src="${escapeAttribute(imageSource)}" alt="${escapeAttribute(property.title || "Property image")}">
    <div class="property-content">
      <div class="property-top">
        <h3>${escapeHtml(property.title || "")}</h3>
        <span>${escapeHtml(property.city || property.location || "")}</span>
      </div>
      <p>${escapeHtml((property.description || "").slice(0, 120))}</p>
      <div class="property-meta">
        <span>${formatCurrency(property.monthly_price || 0)}/mo</span>
        <span>${property.min_term_months}-${property.max_term_months} months</span>
      </div>
      <div class="property-actions">
        <button class="property-open-btn" type="button" data-favorite-id="${property.id}">
          ${isFavorite ? "Remove favorite" : "Save to watchlist"}
        </button>
      </div>
    </div>
  `;

  const favoriteButton = card.querySelector("[data-favorite-id]");
  if (favoriteButton instanceof HTMLButtonElement) {
    favoriteButton.addEventListener("click", async () => {
      const id = Number(favoriteButton.dataset.favoriteId);
      if (!id) {
        return;
      }
      if (isFavorite) {
        await fetch(`/api/tenant/favorites/${id}`, { method: "DELETE" });
      } else {
        await fetch(`/api/tenant/favorites/${id}`, { method: "POST" });
      }
      await loadFavorites();
      renderTenantBrowseGrid();
      renderMetrics();
    });
  }

  return card;
}

function setDashboardMessage(node, text, isError = false) {
  if (!(node instanceof HTMLElement)) {
    return;
  }
  node.textContent = text;
  node.classList.toggle("is-error", isError);
}

function notifyTenantError(text) {
  const node = document.getElementById("tenant-booking-message");
  setDashboardMessage(node, text, true);
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

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

