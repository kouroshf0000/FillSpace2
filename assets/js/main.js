"use strict";

(function initSite() {
  const body = document.body;
  const nav = document.querySelector(".site-nav");
  const menuToggle = document.querySelector(".menu-toggle");
  const modal = document.getElementById("info-modal");
  const openModalButtons = document.querySelectorAll("[data-open-info]");
  const closeModalButtons = document.querySelectorAll("[data-close-info]");
  const leadForms = document.querySelectorAll("[data-lead-form]");
  const toast = document.getElementById("form-toast");

  if (menuToggle && nav) {
    menuToggle.addEventListener("click", () => {
      const willOpen = !nav.classList.contains("open");
      nav.classList.toggle("open", willOpen);
      menuToggle.setAttribute("aria-expanded", String(willOpen));
    });

    document.addEventListener("click", (event) => {
      if (!nav.classList.contains("open")) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        !target.closest(".site-nav") &&
        !target.closest(".menu-toggle")
      ) {
        nav.classList.remove("open");
        menuToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  const openInfoModal = () => {
    if (!modal) {
      return;
    }
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    body.style.overflow = "hidden";
    const focusTarget = modal.querySelector("input, select, textarea, button");
    if (focusTarget instanceof HTMLElement) {
      focusTarget.focus();
    }
  };

  const closeInfoModal = () => {
    if (!modal) {
      return;
    }
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    body.style.overflow = "";
  };

  openModalButtons.forEach((button) => {
    button.addEventListener("click", openInfoModal);
  });

  closeModalButtons.forEach((button) => {
    button.addEventListener("click", closeInfoModal);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeInfoModal();
    }
  });

  const showToast = (message) => {
    if (!toast) {
      return;
    }
    if (message) {
      toast.textContent = message;
    }
    toast.classList.add("show");
    window.setTimeout(() => {
      toast.classList.remove("show");
    }, 2400);
  };

  leadForms.forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const name = String(formData.get("name") || "").trim();
      const customMessage = name ? `Thanks ${name}! We'll follow up within 1 business day.` : "";
      form.reset();
      showToast(customMessage || "Thanks! We'll follow up within 1 business day.");
      closeInfoModal();
    });
  });

  initBrowseFilters();
})();

function initBrowseFilters() {
  const listingGrid = document.getElementById("listing-grid");
  if (!(listingGrid instanceof HTMLElement)) {
    return;
  }

  const cards = Array.from(listingGrid.querySelectorAll(".property-card"));
  if (!cards.length) {
    return;
  }

  cards.forEach((card, idx) => {
    card.dataset.rank = String(idx);
  });

  const locationFilter = document.getElementById("filter-location");
  const sizeFilter = document.getElementById("filter-size");
  const priceFilter = document.getElementById("filter-price");
  const amenityFilter = document.getElementById("filter-amenity");
  const sortFilter = document.getElementById("sort-listings");
  const resetButton = document.getElementById("reset-filters");
  const resultsCount = document.getElementById("results-count");

  const filterControls = [
    locationFilter,
    sizeFilter,
    priceFilter,
    amenityFilter,
    sortFilter,
  ].filter((node) => node instanceof HTMLElement);

  filterControls.forEach((control) => {
    control.addEventListener("change", () => applyFilters(cards, listingGrid, resultsCount));
    if (control instanceof HTMLInputElement) {
      control.addEventListener("input", () => applyFilters(cards, listingGrid, resultsCount));
    }
  });

  if (resetButton instanceof HTMLElement) {
    resetButton.addEventListener("click", () => {
      if (locationFilter instanceof HTMLSelectElement) {
        locationFilter.value = "any";
      }
      if (sizeFilter instanceof HTMLInputElement) {
        sizeFilter.value = "";
      }
      if (priceFilter instanceof HTMLSelectElement) {
        priceFilter.value = "any";
      }
      if (amenityFilter instanceof HTMLSelectElement) {
        amenityFilter.value = "any";
      }
      if (sortFilter instanceof HTMLSelectElement) {
        sortFilter.value = "recommended";
      }
      applyFilters(cards, listingGrid, resultsCount);
    });
  }

  hydrateFiltersFromQuery(locationFilter, priceFilter);
  applyFilters(cards, listingGrid, resultsCount);
}

function hydrateFiltersFromQuery(locationFilter, priceFilter) {
  const params = new URLSearchParams(window.location.search);
  const locationRaw = String(params.get("location") || "").toLowerCase();
  const budgetRaw = Number(params.get("budget") || "");

  if (locationFilter instanceof HTMLSelectElement && locationRaw) {
    if (locationRaw.includes("boston")) {
      locationFilter.value = "Boston";
    } else if (locationRaw.includes("cambridge")) {
      locationFilter.value = "Cambridge";
    } else if (locationRaw.includes("somerville")) {
      locationFilter.value = "Somerville";
    }
  }

  if (priceFilter instanceof HTMLSelectElement && Number.isFinite(budgetRaw) && budgetRaw > 0) {
    const allowedValues = [4000, 6000, 8000, 10000];
    const closest = allowedValues.find((value) => budgetRaw <= value) || allowedValues.at(-1);
    if (closest) {
      priceFilter.value = String(closest);
    }
  }
}

function applyFilters(cards, listingGrid, resultsCount) {
  const locationFilter = document.getElementById("filter-location");
  const sizeFilter = document.getElementById("filter-size");
  const priceFilter = document.getElementById("filter-price");
  const amenityFilter = document.getElementById("filter-amenity");
  const sortFilter = document.getElementById("sort-listings");

  const locationValue = locationFilter instanceof HTMLSelectElement ? locationFilter.value : "any";
  const minimumSize = sizeFilter instanceof HTMLInputElement && sizeFilter.value ? Number(sizeFilter.value) : 0;
  const maxPrice = priceFilter instanceof HTMLSelectElement && priceFilter.value !== "any" ? Number(priceFilter.value) : Infinity;
  const amenityValue = amenityFilter instanceof HTMLSelectElement ? amenityFilter.value : "any";
  const sortValue = sortFilter instanceof HTMLSelectElement ? sortFilter.value : "recommended";

  const filteredCards = cards.filter((card) => {
    const cardLocation = String(card.dataset.location || "");
    const cardSize = Number(card.dataset.size || "0");
    const cardPrice = Number(card.dataset.price || "0");
    const cardAmenities = String(card.dataset.amenities || "");

    const locationMatch = locationValue === "any" || cardLocation === locationValue;
    const sizeMatch = Number.isNaN(minimumSize) || cardSize >= minimumSize;
    const priceMatch = cardPrice <= maxPrice;
    const amenityMatch = amenityValue === "any" || cardAmenities.includes(amenityValue);

    const isVisible = locationMatch && sizeMatch && priceMatch && amenityMatch;
    card.classList.toggle("is-hidden", !isVisible);
    return isVisible;
  });

  const sortedCards = [...filteredCards];
  sortedCards.sort((a, b) => {
    const priceA = Number(a.dataset.price || "0");
    const priceB = Number(b.dataset.price || "0");
    const sizeA = Number(a.dataset.size || "0");
    const sizeB = Number(b.dataset.size || "0");
    const rankA = Number(a.dataset.rank || "0");
    const rankB = Number(b.dataset.rank || "0");

    switch (sortValue) {
      case "price-low":
        return priceA - priceB;
      case "price-high":
        return priceB - priceA;
      case "size-large":
        return sizeB - sizeA;
      default:
        return rankA - rankB;
    }
  });

  sortedCards.forEach((card) => {
    listingGrid.appendChild(card);
  });

  if (resultsCount instanceof HTMLElement) {
    const total = filteredCards.length;
    resultsCount.textContent = `${total} propert${total === 1 ? "y" : "ies"} available`;
  }
}
