"use strict";

(function initSite() {
  const body = document.body;
  const nav = document.querySelector(".site-nav");
  const menuToggle = document.querySelector(".menu-toggle");
  const infoModal = document.getElementById("info-modal");
  const propertyModal = document.getElementById("property-modal");
  const modals = [infoModal, propertyModal].filter((node) => node instanceof HTMLElement);
  const openInfoButtons = document.querySelectorAll("[data-open-info]");
  const closeInfoButtons = document.querySelectorAll("[data-close-info]");
  const closePropertyButtons = document.querySelectorAll("[data-close-property]");
  const contactForms = document.querySelectorAll("[data-contact-form]");
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

  const syncBodyScrollLock = () => {
    const hasOpenModal = modals.some((modalNode) => modalNode.classList.contains("is-open"));
    body.style.overflow = hasOpenModal ? "hidden" : "";
  };

  const openModal = (modalNode) => {
    if (!(modalNode instanceof HTMLElement)) {
      return;
    }
    modals.forEach((node) => {
      if (node !== modalNode) {
        node.classList.remove("is-open");
        node.setAttribute("aria-hidden", "true");
      }
    });
    modalNode.classList.add("is-open");
    modalNode.setAttribute("aria-hidden", "false");
    syncBodyScrollLock();
    const focusTarget = modalNode.querySelector("input, select, textarea, button");
    if (focusTarget instanceof HTMLElement) {
      focusTarget.focus();
    }
  };

  const closeModal = (modalNode) => {
    if (!(modalNode instanceof HTMLElement)) {
      return;
    }
    modalNode.classList.remove("is-open");
    modalNode.setAttribute("aria-hidden", "true");
    syncBodyScrollLock();
  };

  const closeAllModals = () => {
    modals.forEach((modalNode) => {
      modalNode.classList.remove("is-open");
      modalNode.setAttribute("aria-hidden", "true");
    });
    syncBodyScrollLock();
  };

  const openInfoModal = () => {
    openModal(infoModal);
  };

  const closeInfoModal = () => {
    closeModal(infoModal);
  };

  const closePropertyModal = () => {
    closeModal(propertyModal);
  };

  openInfoButtons.forEach((button) => {
    button.addEventListener("click", openInfoModal);
  });

  closeInfoButtons.forEach((button) => {
    button.addEventListener("click", closeInfoModal);
  });

  closePropertyButtons.forEach((button) => {
    button.addEventListener("click", closePropertyModal);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    if (propertyModal instanceof HTMLElement && propertyModal.classList.contains("is-open")) {
      closePropertyModal();
      return;
    }
    closeInfoModal();
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

  contactForms.forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const name = String(formData.get("name") || "").trim();
      const customMessage = name ? `Thanks ${name}! We'll follow up within 1 business day.` : "";
      form.reset();
      showToast(customMessage || "Thanks! We'll follow up within 1 business day.");
      closeAllModals();
    });
  });

  initBrowseFilters();
  initBrowsePropertyDetails({
    openModal,
    closeModal,
    openInfoModal,
  });
  initScrollReveal();
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

function initBrowsePropertyDetails(modalApi) {
  const listingGrid = document.getElementById("listing-grid");
  const propertyModal = document.getElementById("property-modal");
  if (!(listingGrid instanceof HTMLElement) || !(propertyModal instanceof HTMLElement)) {
    return;
  }

  const cards = Array.from(listingGrid.querySelectorAll(".property-card"));
  if (!cards.length) {
    return;
  }

  const titleNode = document.getElementById("property-modal-title");
  const locationNode = document.getElementById("property-modal-location");
  const subtitleNode = document.getElementById("property-modal-subtitle");
  const descriptionNode = document.getElementById("property-modal-description");
  const availabilityNode = document.getElementById("property-modal-availability");
  const bestForNode = document.getElementById("property-modal-best-for");
  const utilitiesNode = document.getElementById("property-modal-utilities");
  const buildoutNode = document.getElementById("property-modal-buildout");
  const highlightsNode = document.getElementById("property-modal-highlights");
  const imageNode = document.getElementById("property-modal-image");
  const propertyContactButton = document.querySelector("[data-property-contact]");

  const openDetails = (card) => {
    const propertyId = String(card.dataset.propertyId || "");
    const details = PROPERTY_DETAILS[propertyId] || createFallbackDetails(card);
    const fallbackImage = card.querySelector("img");

    setText(locationNode, details.location);
    setText(titleNode, details.title);
    setText(subtitleNode, `${details.size} | ${details.price} | ${details.term}`);
    setText(descriptionNode, details.description);
    setText(availabilityNode, details.availability);
    setText(bestForNode, details.bestFor);
    setText(utilitiesNode, details.utilities);
    setText(buildoutNode, details.buildout);

    if (highlightsNode instanceof HTMLElement) {
      highlightsNode.innerHTML = "";
      details.highlights.forEach((highlight) => {
        const item = document.createElement("li");
        item.textContent = highlight;
        highlightsNode.appendChild(item);
      });
    }

    if (imageNode instanceof HTMLImageElement) {
      imageNode.src = details.image || (fallbackImage instanceof HTMLImageElement ? fallbackImage.src : "");
      imageNode.alt = details.imageAlt || (fallbackImage instanceof HTMLImageElement ? fallbackImage.alt : "Property image");
    }

    modalApi.openModal(propertyModal);
  };

  cards.forEach((card) => {
    card.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (target.closest("button, a, input, select, textarea, label")) {
        return;
      }
      openDetails(card);
    });

    const detailsButton = card.querySelector("[data-open-property]");
    if (detailsButton instanceof HTMLElement) {
      detailsButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openDetails(card);
      });
    }
  });

  if (propertyContactButton instanceof HTMLElement) {
    propertyContactButton.addEventListener("click", () => {
      modalApi.closeModal(propertyModal);
      modalApi.openInfoModal();
    });
  }
}

function setText(node, value) {
  if (node instanceof HTMLElement) {
    node.textContent = value;
  }
}

function createFallbackDetails(card) {
  const title = card.querySelector("h3");
  const location = card.querySelector(".property-top span");
  const metaValues = card.querySelectorAll(".property-meta span");
  const image = card.querySelector("img");

  return {
    title: title instanceof HTMLElement ? title.textContent?.trim() || "Property details" : "Property details",
    location: location instanceof HTMLElement ? location.textContent?.trim() || "Greater Boston" : "Greater Boston",
    size: `${card.dataset.size || "N/A"} sq ft`,
    price: metaValues[0]?.textContent?.trim() || "Contact for pricing",
    term: metaValues[1]?.textContent?.trim() || "Flexible term",
    availability: "Contact for availability",
    bestFor: "Retail, office, and short-term pilots",
    utilities: "Based on location and unit setup",
    buildout: "Light cosmetic changes only",
    description: "This space supports flexible occupancy with FillSpace's streamlined approval process.",
    highlights: [
      "Verified operator workflow",
      "Insurance included in the process",
      "Owner approval and structured terms",
    ],
    image: image instanceof HTMLImageElement ? image.src : "",
    imageAlt: image instanceof HTMLImageElement ? image.alt : "Property image",
  };
}

function initScrollReveal() {
  const selectors = [
    ".section-heading",
    ".visual-card",
    ".property-card",
    ".split-card",
    ".step-card",
    ".side-panel",
    ".facts-grid article",
    ".model-grid article",
  ];
  const elements = Array.from(document.querySelectorAll(selectors.join(",")));
  if (!elements.length) {
    return;
  }

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  elements.forEach((element, index) => {
    element.classList.add("reveal-on-scroll");
    element.style.setProperty("--reveal-delay", `${Math.min(index % 6, 5) * 55}ms`);
  });

  if (reducedMotion || !("IntersectionObserver" in window)) {
    elements.forEach((element) => element.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    {
      threshold: 0.14,
      rootMargin: "0px 0px -10% 0px",
    }
  );

  elements.forEach((element) => observer.observe(element));
}

const PROPERTY_DETAILS = {
  "seaport-retail-corner": {
    title: "Seaport Retail Corner",
    location: "Seaport District, Boston MA",
    size: "1,900 sq ft",
    price: "$6,200/mo",
    term: "1-4 months",
    availability: "Available within 2 weeks",
    bestFor: "Retail pop-ups and consumer launches",
    utilities: "HVAC, internet, and base power included",
    buildout: "Light merchandising changes only",
    description:
      "Corner storefront in one of Boston's highest-traffic neighborhoods. Built for fast activations with minimal setup friction.",
    highlights: [
      "Street-facing glass frontage with premium visibility",
      "Walkable to transit, offices, and hotel clusters",
      "Owner approval workflow completed in up to 48 hours",
      "Insurance and contract flow managed in-platform",
    ],
    image: "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=1200&q=80",
    imageAlt: "Retail corner with city-facing windows",
  },
  "kendall-growth-studio": {
    title: "Kendall Growth Studio",
    location: "Kendall Square, Cambridge MA",
    size: "2,300 sq ft",
    price: "$8,100/mo",
    term: "2-6 months",
    availability: "Available next month",
    bestFor: "Venture-backed teams and pilot HQs",
    utilities: "Fiber internet, utilities, and conference AV",
    buildout: "No major structural modifications",
    description:
      "Plug-and-play workspace designed for operators that need speed. Includes furnished team zones and client-ready meeting rooms.",
    highlights: [
      "Turnkey office layout for immediate occupancy",
      "Dedicated conference and collaboration spaces",
      "Close to Red Line and Kendall innovation corridor",
      "Supports short-term growth sprints without long lease lock-in",
    ],
    image: "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1200&q=80",
    imageAlt: "Modern furnished office with collaboration areas",
  },
  "back-bay-pop-up-loft": {
    title: "Back Bay Pop-up Loft",
    location: "Back Bay, Boston MA",
    size: "1,250 sq ft",
    price: "$4,850/mo",
    term: "1-3 months",
    availability: "Available now",
    bestFor: "Brand activations and DTC test launches",
    utilities: "Standard utilities and display lighting package",
    buildout: "Cosmetic staging and temporary fixtures allowed",
    description:
      "Loft-style unit with strong natural light and adaptable floor plan for product showcases, capsule drops, and seasonal pop-ups.",
    highlights: [
      "High-visibility location near premium shopping corridors",
      "Open plan layout for flexible merchandising",
      "Fast onboarding with verification and e-sign workflow",
      "Clear move-out standards to protect owner value",
    ],
    image: "https://images.unsplash.com/photo-1473448912268-2022ce9509d8?auto=format&fit=crop&w=1200&q=80",
    imageAlt: "Pop-up retail loft with wide windows and natural light",
  },
  "assembly-flex-unit": {
    title: "Assembly Flex Unit",
    location: "Assembly Row, Somerville MA",
    size: "2,100 sq ft",
    price: "$5,600/mo",
    term: "2-5 months",
    availability: "Available within 30 days",
    bestFor: "Hybrid showroom and fulfillment operations",
    utilities: "Power, loading access, and parking included",
    buildout: "Light equipment installation only",
    description:
      "Balanced front-of-house and back-of-house format ideal for operators combining customer experience with light operational throughput.",
    highlights: [
      "Loading access for inventory turnover",
      "Flexible layout with front display and back storage zones",
      "Convenient access to transit and major road links",
      "Structured terms built for pilot and expansion phases",
    ],
    image: "https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1200&q=80",
    imageAlt: "Flex commercial unit with industrial-modern interior",
  },
  "south-end-showcase": {
    title: "South End Showcase",
    location: "South End, Boston MA",
    size: "950 sq ft",
    price: "$3,400/mo",
    term: "1-2 months",
    availability: "Available now",
    bestFor: "Boutique concepts and local market tests",
    utilities: "Base utilities with optional internet upgrade",
    buildout: "No major buildout permitted",
    description:
      "Compact street-level space tailored for focused campaigns and first-location experiments with manageable overhead.",
    highlights: [
      "Street frontage in a walkable neighborhood",
      "Low-footprint option for early-stage concepts",
      "Simple move-in requirements and clear operating terms",
      "Great fit for seasonal launches and short pilots",
    ],
    image: "https://images.unsplash.com/photo-1519567241046-7f570eee3ce6?auto=format&fit=crop&w=1200&q=80",
    imageAlt: "Street-facing boutique storefront",
  },
  "financial-district-showroom": {
    title: "Financial District Showroom",
    location: "Financial District, Boston MA",
    size: "1,800 sq ft",
    price: "$5,900/mo",
    term: "2-5 months",
    availability: "Available within 3 weeks",
    bestFor: "B2B demos, enterprise showcases, and events",
    utilities: "Conference AV, utilities, and hosted internet",
    buildout: "Presentation-ready layout with light staging updates",
    description:
      "Showroom-style space combining polished client-facing zones with flexible event setup for recurring demos and presentations.",
    highlights: [
      "Built-in meeting and presentation flow",
      "Prime downtown address for customer-facing sessions",
      "Supports recurring demos and short campaign programs",
      "Owner-protected terms with platform-managed documentation",
    ],
    image: "https://images.unsplash.com/photo-1497215842964-222b430dc094?auto=format&fit=crop&w=1200&q=80",
    imageAlt: "Downtown showroom space with presentation lounge",
  },
};
