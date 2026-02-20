"use strict";

const subtitle = document.getElementById("storefront-subtitle");
const productsRoot = document.getElementById("storefront-products");

initializeStorefront();

async function initializeStorefront() {
  const params = new URLSearchParams(window.location.search);
  const accountId = String(params.get("accountId") || localStorage.getItem("accountId") || "").trim();
  if (!accountId) {
    if (subtitle instanceof HTMLElement) {
      subtitle.textContent = "No connected account id provided.";
    }
    return;
  }

  if (subtitle instanceof HTMLElement) {
    subtitle.textContent = `Products for account ${accountId}`;
  }

  try {
    const response = await fetch(`/api/products/${encodeURIComponent(accountId)}`);
    if (!response.ok) {
      throw new Error("Failed to load products");
    }
    const products = await response.json();
    renderStorefront(products, accountId);
  } catch {
    if (subtitle instanceof HTMLElement) {
      subtitle.textContent = "Unable to load products right now.";
    }
  }
}

function renderStorefront(products, accountId) {
  if (!(productsRoot instanceof HTMLElement)) {
    return;
  }
  if (!Array.isArray(products) || !products.length) {
    productsRoot.innerHTML = "<p>No products available yet.</p>";
    return;
  }

  productsRoot.innerHTML = "";
  for (const product of products) {
    const card = document.createElement("article");
    card.className = "product storefront-product";
    const amount = Number(product.price || 0) / 100;
    const period = product.period ? ` / ${escapeHtml(product.period)}` : "";
    card.innerHTML = `
      <div class="product-info">
        <img class="product-image" src="${escapeAttribute(product.image || "https://i.imgur.com/6Mvijcm.png")}" alt="Product image">
        <div class="description">
          <h3 class="product-name">${escapeHtml(product.name || "Product")}</h3>
          <h5 class="product-price">$${amount.toFixed(2)}${period}</h5>
          <p>${escapeHtml(product.description || "")}</p>
        </div>
      </div>
      <form action="/api/create-checkout-session" method="POST" class="checkout-form">
        <input type="hidden" name="priceId" value="${escapeAttribute(product.priceId || "")}">
        <input type="hidden" name="accountId" value="${escapeAttribute(accountId)}">
        <button type="submit" class="btn btn-primary">Checkout</button>
      </form>
    `;
    productsRoot.appendChild(card);
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

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
