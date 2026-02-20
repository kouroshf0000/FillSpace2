"use strict";

let accountId = localStorage.getItem("accountId");

function setAccountId(nextAccountId) {
  accountId = String(nextAccountId || "").trim();
}

async function fetchProducts() {
  const productsList = document.getElementById("products-list");
  if (!productsList || !accountId) {
    return [];
  }

  try {
    const response = await fetch(`/api/products/${encodeURIComponent(accountId)}`);
    if (!response.ok) {
      throw new Error("Failed to fetch products");
    }
    const products = await response.json();
    renderProducts(products);
    return products;
  } catch (error) {
    console.error("Error fetching products:", error);
    return [];
  }
}

function renderProducts(products) {
  const productsList = document.getElementById("products-list");
  if (!productsList) {
    return;
  }
  if (!Array.isArray(products) || products.length === 0) {
    productsList.innerHTML = "<p>No products found.</p>";
    return;
  }

  const templateProductDiv = productsList.querySelector(".product.hidden");
  if (!templateProductDiv) {
    productsList.innerHTML = "<p>Product template is missing.</p>";
    return;
  }

  const existingProducts = productsList.querySelectorAll(".product:not(.hidden)");
  existingProducts.forEach((product) => product.remove());

  products.forEach((product) => {
    const productDiv = templateProductDiv.cloneNode(true);
    productDiv.classList.remove("hidden");

    const nameEl = productDiv.querySelector(".product-name");
    if (nameEl) {
      nameEl.textContent = product.name || "Product";
    }

    const priceEl = productDiv.querySelector(".product-price");
    if (priceEl) {
      const amount = Number(product.price || 0) / 100;
      priceEl.textContent = `$${amount.toFixed(2)}`;
      if (product.period) {
        priceEl.textContent += ` / ${product.period}`;
      }
    }

    const priceIdInput = productDiv.querySelector('input[name="priceId"]');
    if (priceIdInput) {
      priceIdInput.value = product.priceId || "";
    }

    const accountIdInput = productDiv.querySelector('input[name="accountId"]');
    if (accountIdInput) {
      accountIdInput.value = accountId;
    }

    const imageEl = productDiv.querySelector(".product-image");
    if (imageEl instanceof HTMLImageElement && product.image) {
      imageEl.src = product.image;
    }

    productsList.appendChild(productDiv);
  });
}

export { fetchProducts, renderProducts, setAccountId };
