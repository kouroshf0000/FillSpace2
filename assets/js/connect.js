"use strict";

import { fetchProducts, setAccountId as setProductsAccountId } from "./products.js";

let accountId = localStorage.getItem("accountId");
let accountStatus = null;
let statusInterval;

const createAccountForm = document.getElementById("create-account-form");
const accountStatusEl = document.getElementById("account-status");
const addProductBtn = document.getElementById("add-product");
const productForm = document.getElementById("create-product-form");
const productsSection = document.getElementById("products-section");
const productsList = document.getElementById("products-list");
const toggleProductsBtn = document.getElementById("toggle-products");
const storefrontsEl = document.getElementById("storefronts");

init();

function init() {
  const urlParams = new URLSearchParams(window.location.search);
  const accountIdFromQuery = String(urlParams.get("accountId") || "").trim();
  if (accountIdFromQuery) {
    accountId = accountIdFromQuery;
    localStorage.setItem("accountId", accountId);
  }
  setProductsAccountId(accountId);

  if (accountId) {
    fetchAccountStatus();
    updateStorefronts();
    startStatusPolling();
  }
  setupEventListeners();
}

function setupEventListeners() {
  if (createAccountForm instanceof HTMLFormElement) {
    createAccountForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = document.getElementById("email")?.value || "";
      await createConnectAccount(String(email));
    });
  }

  if (productForm instanceof HTMLFormElement) {
    productForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const productName = String(document.getElementById("productName")?.value || "").trim();
      const productDescription = String(document.getElementById("productDescription")?.value || "").trim();
      const productPrice = Number(document.getElementById("productPrice")?.value || 0);
      await createProduct(productName, productDescription, productPrice);
      productForm.classList.add("hidden");
      if (addProductBtn instanceof HTMLButtonElement) {
        addProductBtn.textContent = "Add New Product";
      }
      fetchProducts();
    });
  }

  if (toggleProductsBtn instanceof HTMLButtonElement && productsList instanceof HTMLElement) {
    toggleProductsBtn.addEventListener("click", () => {
      const isHidden = productsList.classList.contains("hidden");
      productsList.classList.toggle("hidden");
      toggleProductsBtn.textContent = isHidden ? "Hide Products" : "Show Products";
      if (isHidden) {
        fetchProducts();
      }
    });
  }

  if (addProductBtn instanceof HTMLButtonElement && productForm instanceof HTMLFormElement) {
    addProductBtn.addEventListener("click", () => {
      productForm.classList.toggle("hidden");
      addProductBtn.textContent = productForm.classList.contains("hidden") ? "Add New Product" : "Cancel";
    });
  }
}

async function fetchAccountStatus() {
  if (!accountId) {
    return;
  }
  try {
    const response = await fetch(`/api/account-status/${encodeURIComponent(accountId)}`);
    if (!response.ok) {
      logout();
      throw new Error("Failed to fetch account status");
    }
    accountStatus = await response.json();
    renderAccountStatus();

    if (accountStatus?.chargesEnabled) {
      addProductBtn?.classList.remove("hidden");
      productsSection?.classList.remove("hidden");
      createAccountForm?.classList.add("hidden");
    }
  } catch (error) {
    console.error("Error fetching account status:", error);
  }
}

function renderAccountStatus() {
  if (!(accountStatusEl instanceof HTMLElement) || !accountStatus) {
    return;
  }

  const statusColor = accountStatus.chargesEnabled ? "#1d5f2a" : "#c26f00";
  const statusText = accountStatus.chargesEnabled ? "Active" : "Pending";

  accountStatusEl.innerHTML = `
    <div class="account-status">
      <h3>Account Status: <span style="color:${statusColor}">${statusText}</span></h3>
      <div class="status-details">
        <div class="status-item"><span>Account ID:</span><span>${escapeHtml(accountStatus.id || "")}</span></div>
        <div class="status-item"><span>Payouts enabled:</span><span>${accountStatus.payoutsEnabled ? "✅" : "❌"}</span></div>
        <div class="status-item"><span>Charges enabled:</span><span>${accountStatus.chargesEnabled ? "✅" : "❌"}</span></div>
        <div class="status-item"><span>Details submitted:</span><span>${accountStatus.detailsSubmitted ? "✅" : "❌"}</span></div>
      </div>
      ${needsOnboarding() ? `<button id="start-onboarding" class="btn btn-primary">Onboard to collect payments</button>` : ""}
      <button id="logout" class="btn btn-secondary">Log out</button>
    </div>
  `;

  if (needsOnboarding()) {
    document.getElementById("start-onboarding")?.addEventListener("click", startOnboarding);
  }
  document.getElementById("logout")?.addEventListener("click", logout);
}

function needsOnboarding() {
  return !accountStatus?.chargesEnabled && !accountStatus?.detailsSubmitted;
}

function logout() {
  accountId = null;
  accountStatus = null;
  localStorage.removeItem("accountId");
  clearInterval(statusInterval);
  setProductsAccountId("");

  if (accountStatusEl instanceof HTMLElement) {
    accountStatusEl.innerHTML = "";
  }
  addProductBtn?.classList.add("hidden");
  productForm?.classList.add("hidden");
  productsSection?.classList.add("hidden");
  productsList?.classList.add("hidden");
  if (toggleProductsBtn instanceof HTMLButtonElement) {
    toggleProductsBtn.textContent = "Show Products";
  }
  createAccountForm?.classList.remove("hidden");
  if (storefrontsEl instanceof HTMLElement) {
    storefrontsEl.innerHTML = "";
  }
}

function updateStorefronts() {
  if (!(storefrontsEl instanceof HTMLElement) || !accountId) {
    return;
  }
  storefrontsEl.innerHTML = `
    <a href="storefront.html?accountId=${encodeURIComponent(accountId)}" class="btn btn-secondary">
      View Storefront (${escapeHtml(accountId)})
    </a>
  `;
}

function startStatusPolling() {
  clearInterval(statusInterval);
  statusInterval = setInterval(fetchAccountStatus, 5000);
}

window.addEventListener("beforeunload", () => {
  clearInterval(statusInterval);
});

async function createConnectAccount(email) {
  try {
    const response = await fetch("/api/create-connect-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!response.ok) {
      throw new Error("Failed to create connect account");
    }
    const payload = await response.json();
    accountId = String(payload.accountId || "");
    if (!accountId) {
      throw new Error("No account id returned");
    }
    localStorage.setItem("accountId", accountId);
    setProductsAccountId(accountId);
    await fetchAccountStatus();
    updateStorefronts();
    startStatusPolling();
  } catch (error) {
    console.error("Error creating connect account:", error);
  }
}

async function startOnboarding() {
  if (!accountId) {
    return;
  }
  try {
    const response = await fetch("/api/create-account-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    if (!response.ok) {
      throw new Error("Failed to start onboarding");
    }
    const { url } = await response.json();
    if (url) {
      window.location.href = url;
    }
  } catch (error) {
    console.error("Error starting onboarding:", error);
  }
}

async function createProduct(productName, productDescription, productPrice) {
  if (!accountId) {
    return;
  }
  try {
    const response = await fetch("/api/create-product", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productName,
        productDescription,
        productPrice,
        accountId,
      }),
    });
    if (!response.ok) {
      throw new Error("Failed to create product");
    }
    document.getElementById("productName").value = "";
    document.getElementById("productDescription").value = "";
    document.getElementById("productPrice").value = "1000";
  } catch (error) {
    console.error("Error creating product:", error);
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
