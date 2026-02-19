"use strict";

(async function initSite() {
  const nav = document.querySelector(".site-nav");
  const menuToggle = document.querySelector(".menu-toggle");
  const propertyModal = document.getElementById("property-modal");
  const closePropertyButtons = document.querySelectorAll("[data-close-property]");
  const body = document.body;

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

    nav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        nav.classList.remove("open");
        menuToggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  const openModal = (modalNode) => {
    if (!(modalNode instanceof HTMLElement)) {
      return;
    }
    modalNode.classList.add("is-open");
    modalNode.setAttribute("aria-hidden", "false");
    body.style.overflow = "hidden";
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
    body.style.overflow = "";
  };

  const closePropertyModal = () => {
    closeModal(propertyModal);
  };

  closePropertyButtons.forEach((button) => {
    button.addEventListener("click", closePropertyModal);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    if (propertyModal instanceof HTMLElement && propertyModal.classList.contains("is-open")) {
      closePropertyModal();
    }
  });

  await hydrateBrowseListingsFromApi();
  initBrowseFilters();
  initBrowsePropertyDetails({
    openModal,
    closeModal,
  });
  initFeaturedPropertyLinks();
  initAskInfoFormPrefill();
  initScrollReveal();
})();

const runtimePropertyDetails = Object.create(null);

async function hydrateBrowseListingsFromApi() {
  const listingGrid = document.getElementById("listing-grid");
  if (!(listingGrid instanceof HTMLElement)) {
    return;
  }

  try {
    const res = await fetch("/api/properties");
    if (!res.ok) {
      return;
    }
    const payload = await res.json();
    const properties = Array.isArray(payload.properties) ? payload.properties : [];
    if (!properties.length) {
      return;
    }

    listingGrid.innerHTML = "";
    for (const property of properties) {
      const card = createBrowseCardFromApi(property);
      listingGrid.appendChild(card);
      runtimePropertyDetails[property.slug] = {
        title: property.title,
        location: property.location,
        size: `${property.size_sqft} sq ft`,
        price: `$${Number(property.monthly_price || 0).toLocaleString("en-US", {
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        })}/mo`,
        term: `${property.min_term_months}-${property.max_term_months} months`,
        availability: property.availability_text || "Available now",
        bestFor: property.best_for || "Flexible commercial occupancy",
        utilities: property.utilities || "Utilities vary by listing",
        buildout: property.buildout || "Light cosmetic changes only",
        description: property.description || "",
        highlights: Array.isArray(property.amenities) && property.amenities.length
          ? property.amenities.map((amenity) => `${amenity} included`)
          : ["Verified businesses", "Streamlined approvals", "Insurance-ready workflow"],
        image: property.image_url || "",
        imageAlt: property.title || "Property image",
      };
    }
  } catch {
    // Keep static fallback cards when API is unavailable.
  }
}

function createBrowseCardFromApi(property) {
  const card = document.createElement("article");
  const amenities = Array.isArray(property.amenities) ? property.amenities : [];
  const amenityTags = amenities.slice(0, 2);
  const amenityDataset = amenities.map((amenity) => toAmenitySlug(amenity)).join(",");
  const locationForFilter = String(property.city || property.location || "any").split(",")[0].trim();
  const description =
    property.description && property.description.length > 130
      ? `${property.description.slice(0, 127)}...`
      : property.description || "Flexible listing for short-term commercial occupancy.";

  card.className = "property-card";
  card.dataset.propertyId = property.slug || `property-${property.id}`;
  card.dataset.location = locationForFilter || "any";
  card.dataset.size = String(property.size_sqft || 0);
  card.dataset.price = String(Math.round(Number(property.monthly_price || 0)));
  card.dataset.amenities = amenityDataset;

  card.innerHTML = `
    <img src="${escapeAttribute(property.image_url || "")}" alt="${escapeAttribute(property.title || "Property image")}">
    <div class="property-content">
      <div class="property-top">
        <h3>${escapeHtml(property.title || "")}</h3>
        <span>${escapeHtml(property.location || "")}</span>
      </div>
      <p>${escapeHtml(description)}</p>
      <div class="tag-row">
        ${amenityTags.map((amenity) => `<span>${escapeHtml(amenity)}</span>`).join("")}
      </div>
      <div class="property-meta">
        <span>$${Number(property.monthly_price || 0).toLocaleString("en-US")}/mo</span>
        <span>${property.min_term_months}-${property.max_term_months} months</span>
      </div>
      <div class="property-actions">
        <button class="property-open-btn" type="button" data-open-property>View details</button>
      </div>
    </div>
  `;

  return card;
}

function toAmenitySlug(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized.includes("loading")) {
    return "loading";
  }
  if (normalized.includes("furnished")) {
    return "furnished";
  }
  if (normalized.includes("foot")) {
    return "foot-traffic";
  }
  if (normalized.includes("parking")) {
    return "parking";
  }
  if (normalized.includes("conference")) {
    return "conference";
  }
  return normalized || "any";
}

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
  const propertyContactLink = document.getElementById("property-contact-link");

  const openDetails = (card) => {
    const propertyId = String(card.dataset.propertyId || "");
    const details = runtimePropertyDetails[propertyId] || PROPERTY_DETAILS[propertyId] || createFallbackDetails(card);
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

    if (propertyContactLink instanceof HTMLAnchorElement) {
      const params = new URLSearchParams({
        property: details.title,
        location: details.location,
        source: "property-modal",
      });
      propertyContactLink.href = `ask-info.html?${params.toString()}`;
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

  const openFromQuery = () => {
    const params = new URLSearchParams(window.location.search);
    const requestedSlug = String(params.get("open") || "").trim().toLowerCase();
    if (!requestedSlug) {
      return;
    }
    const card = cards.find(
      (entry) => String(entry.dataset.propertyId || "").trim().toLowerCase() === requestedSlug
    );
    if (!card) {
      return;
    }
    openDetails(card);
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  openFromQuery();

  if (propertyContactLink instanceof HTMLAnchorElement) {
    propertyContactLink.addEventListener("click", () => {
      modalApi.closeModal(propertyModal);
    });
  }
}

function initFeaturedPropertyLinks() {
  const featuredCards = Array.from(document.querySelectorAll(".page-home .property-card[data-featured-slug]"));
  if (!featuredCards.length) {
    return;
  }

  featuredCards.forEach((card) => {
    const slug = String(card.dataset.featuredSlug || "").trim();
    if (!slug) {
      return;
    }
    const titleText = card.querySelector("h3")?.textContent?.trim() || "featured property";
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "link");
    card.setAttribute("aria-label", `Open details for ${titleText}`);

    const openCard = () => {
      const params = new URLSearchParams({ open: slug });
      window.location.href = `browse.html?${params.toString()}`;
    };

    card.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("a, button, input, select, textarea, label")) {
        return;
      }
      openCard();
    });

    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openCard();
      }
    });
  });
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

function initAskInfoFormPrefill() {
  const form = document.getElementById("ask-info-form");
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const property = String(params.get("property") || "").trim();
  const location = String(params.get("location") || "").trim();
  const source = String(params.get("source") || "website").trim();
  const goal = String(params.get("goal") || "").trim();

  const propertyField = document.getElementById("ask-property-context");
  const locationField = document.getElementById("ask-location-context");
  const sourceField = document.getElementById("ask-source");
  const goalField = document.getElementById("ask-goal");
  const subjectField = document.getElementById("ask-subject");
  const contextBadge = document.getElementById("ask-context-badge");
  const propertyGroup = document.getElementById("ask-property-group");
  const locationGroup = document.getElementById("ask-location-group");

  if (sourceField instanceof HTMLInputElement) {
    sourceField.value = source || "website";
  }

  if (propertyField instanceof HTMLInputElement) {
    propertyField.value = property;
  }

  if (locationField instanceof HTMLInputElement) {
    locationField.value = location;
  }

  if (propertyGroup instanceof HTMLElement && !property) {
    propertyGroup.classList.add("is-hidden");
  }

  if (locationGroup instanceof HTMLElement && !location) {
    locationGroup.classList.add("is-hidden");
  }

  if (goalField instanceof HTMLSelectElement && goal) {
    const matchedOption = Array.from(goalField.options).find((option) => option.value === goal);
    if (matchedOption) {
      goalField.value = goal;
    }
  }

  if (subjectField instanceof HTMLInputElement && property) {
    subjectField.value = `New FillSpace inquiry for ${property}`;
  }

  if (contextBadge instanceof HTMLElement && property) {
    contextBadge.textContent = location ? `${property} • ${location}` : property;
  } else if (contextBadge instanceof HTMLElement) {
    contextBadge.textContent = "General inquiry";
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
