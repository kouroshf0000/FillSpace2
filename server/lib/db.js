const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "fillspace.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('owner', 'tenant')),
    name TEXT NOT NULL,
    company TEXT DEFAULT '',
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    stripe_account_id TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS properties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    location TEXT NOT NULL,
    city TEXT DEFAULT '',
    state TEXT DEFAULT '',
    size_sqft INTEGER NOT NULL,
    monthly_price_cents INTEGER NOT NULL,
    min_term_months INTEGER NOT NULL,
    max_term_months INTEGER NOT NULL,
    availability_text TEXT NOT NULL DEFAULT 'Available now',
    best_for TEXT NOT NULL DEFAULT '',
    utilities TEXT NOT NULL DEFAULT '',
    buildout TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    amenities_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(owner_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id INTEGER NOT NULL,
    tenant_id INTEGER NOT NULL,
    owner_id INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    total_cents INTEGER NOT NULL,
    platform_fee_cents INTEGER NOT NULL,
    owner_payout_cents INTEGER NOT NULL,
    stripe_checkout_session_id TEXT UNIQUE,
    stripe_payment_intent_id TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(property_id) REFERENCES properties(id),
    FOREIGN KEY(tenant_id) REFERENCES users(id),
    FOREIGN KEY(owner_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    property_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, property_id),
    FOREIGN KEY(tenant_id) REFERENCES users(id),
    FOREIGN KEY(property_id) REFERENCES properties(id)
  );

  CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    company TEXT NOT NULL DEFAULT '',
    goal TEXT NOT NULL DEFAULT '',
    timeline TEXT NOT NULL DEFAULT '',
    budget TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL,
    property_interest TEXT NOT NULL DEFAULT '',
    property_location TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'website',
    subject TEXT NOT NULL DEFAULT 'New FillSpace inquiry',
    email_forwarded INTEGER NOT NULL DEFAULT 0,
    forward_status TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

function slugify(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function centsFromUsd(input) {
  const number = Number(input);
  if (!Number.isFinite(number) || number < 0) {
    return 0;
  }
  return Math.round(number * 100);
}

function usdFromCents(cents) {
  const value = Number(cents || 0) / 100;
  return Number(value.toFixed(2));
}

function seedUsers() {
  const ownerEmail = "owner@fillspace.com";
  const tenantEmail = "tenant@fillspace.com";
  const userByEmailStmt = db.prepare("SELECT id FROM users WHERE email = ?");

  const insertStmt = db.prepare(`
    INSERT INTO users (role, name, company, email, password_hash)
    VALUES (@role, @name, @company, @email, @password_hash)
  `);

  if (!userByEmailStmt.get(ownerEmail)) {
    insertStmt.run({
      role: "owner",
      name: "Demo Owner",
      company: "FillSpace Owner Group",
      email: ownerEmail,
      password_hash: bcrypt.hashSync("Owner123!", 10),
    });
  }

  if (!userByEmailStmt.get(tenantEmail)) {
    insertStmt.run({
      role: "tenant",
      name: "Demo Tenant",
      company: "Pilot Retail Co.",
      email: tenantEmail,
      password_hash: bcrypt.hashSync("Tenant123!", 10),
    });
  }
}

function seedProperties() {
  const owner = db.prepare("SELECT id FROM users WHERE email = ?").get("owner@fillspace.com");
  if (!owner) {
    return;
  }

  const properties = [
    {
      slug: "seaport-retail-corner",
      title: "Seaport Retail Corner",
      description:
        "Corner storefront in one of Boston's highest-traffic neighborhoods built for fast activations and rapid occupancy.",
      location: "Seaport District, Boston MA",
      city: "Boston",
      state: "MA",
      size_sqft: 1900,
      monthly_price_cents: centsFromUsd(6200),
      min_term_months: 1,
      max_term_months: 4,
      availability_text: "Available within 2 weeks",
      best_for: "Retail pop-ups and consumer launches",
      utilities: "HVAC, internet, and base power included",
      buildout: "Light merchandising changes only",
      image_url:
        "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=1200&q=80",
      amenities_json: JSON.stringify(["Foot traffic", "Furnished"]),
    },
    {
      slug: "kendall-growth-studio",
      title: "Kendall Growth Studio",
      description:
        "Plug-and-play office for scaling teams with conference-ready zones and high-speed connectivity.",
      location: "Kendall Square, Cambridge MA",
      city: "Cambridge",
      state: "MA",
      size_sqft: 2300,
      monthly_price_cents: centsFromUsd(8100),
      min_term_months: 2,
      max_term_months: 6,
      availability_text: "Available next month",
      best_for: "Venture-backed teams and pilot HQs",
      utilities: "Fiber internet, utilities, and conference AV",
      buildout: "No major structural modifications",
      image_url:
        "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=1200&q=80",
      amenities_json: JSON.stringify(["Conference", "Parking"]),
    },
    {
      slug: "back-bay-pop-up-loft",
      title: "Back Bay Pop-up Loft",
      description:
        "Loft-style unit with natural light and adaptable layout for high-impact brand activations.",
      location: "Back Bay, Boston MA",
      city: "Boston",
      state: "MA",
      size_sqft: 1250,
      monthly_price_cents: centsFromUsd(4850),
      min_term_months: 1,
      max_term_months: 3,
      availability_text: "Available now",
      best_for: "Brand activations and DTC test launches",
      utilities: "Standard utilities and display lighting package",
      buildout: "Cosmetic staging and temporary fixtures allowed",
      image_url:
        "https://images.unsplash.com/photo-1473448912268-2022ce9509d8?auto=format&fit=crop&w=1200&q=80",
      amenities_json: JSON.stringify(["Foot traffic", "Loading access"]),
    },
    {
      slug: "assembly-flex-unit",
      title: "Assembly Flex Unit",
      description:
        "Hybrid showroom and back-of-house format with loading support and parking for flexible operations.",
      location: "Assembly Row, Somerville MA",
      city: "Somerville",
      state: "MA",
      size_sqft: 2100,
      monthly_price_cents: centsFromUsd(5600),
      min_term_months: 2,
      max_term_months: 5,
      availability_text: "Available within 30 days",
      best_for: "Hybrid showroom and fulfillment operations",
      utilities: "Power, loading access, and parking included",
      buildout: "Light equipment installation only",
      image_url:
        "https://images.unsplash.com/photo-1497366754035-f200968a6e72?auto=format&fit=crop&w=1200&q=80",
      amenities_json: JSON.stringify(["Loading access", "Parking"]),
    },
    {
      slug: "south-end-showcase",
      title: "South End Showcase",
      description:
        "Compact street-level retail space ideal for targeted market tests and short campaign windows.",
      location: "South End, Boston MA",
      city: "Boston",
      state: "MA",
      size_sqft: 950,
      monthly_price_cents: centsFromUsd(3400),
      min_term_months: 1,
      max_term_months: 2,
      availability_text: "Available now",
      best_for: "Boutique concepts and local market tests",
      utilities: "Base utilities with optional internet upgrade",
      buildout: "No major buildout permitted",
      image_url:
        "https://images.unsplash.com/photo-1519567241046-7f570eee3ce6?auto=format&fit=crop&w=1200&q=80",
      amenities_json: JSON.stringify(["Foot traffic", "Street frontage"]),
    },
    {
      slug: "financial-district-showroom",
      title: "Financial District Showroom",
      description:
        "Downtown destination showroom for enterprise demos, launches, and customer-facing sessions.",
      location: "Financial District, Boston MA",
      city: "Boston",
      state: "MA",
      size_sqft: 1800,
      monthly_price_cents: centsFromUsd(5900),
      min_term_months: 2,
      max_term_months: 5,
      availability_text: "Available within 3 weeks",
      best_for: "B2B demos, enterprise showcases, and events",
      utilities: "Conference AV, utilities, and hosted internet",
      buildout: "Presentation-ready layout with light staging updates",
      image_url:
        "https://images.unsplash.com/photo-1497215842964-222b430dc094?auto=format&fit=crop&w=1200&q=80",
      amenities_json: JSON.stringify(["Conference", "Foot traffic"]),
    },
  ];

  const getExistingStmt = db.prepare("SELECT id FROM properties WHERE slug = ?");
  const insertStmt = db.prepare(`
    INSERT INTO properties (
      owner_id, slug, title, description, location, city, state,
      size_sqft, monthly_price_cents, min_term_months, max_term_months,
      availability_text, best_for, utilities, buildout, image_url, amenities_json, status
    )
    VALUES (
      @owner_id, @slug, @title, @description, @location, @city, @state,
      @size_sqft, @monthly_price_cents, @min_term_months, @max_term_months,
      @availability_text, @best_for, @utilities, @buildout, @image_url, @amenities_json, 'active'
    )
  `);

  for (const property of properties) {
    if (!getExistingStmt.get(property.slug)) {
      insertStmt.run({
        ...property,
        owner_id: owner.id,
      });
    }
  }
}

function seedDatabase() {
  seedUsers();
  seedProperties();
}

seedDatabase();

function sanitizeUser(user) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    role: user.role,
    name: user.name,
    company: user.company,
    email: user.email,
    stripe_account_id: user.stripe_account_id || "",
    created_at: user.created_at,
  };
}

function normalizePropertyRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    owner_id: row.owner_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    location: row.location,
    city: row.city,
    state: row.state,
    size_sqft: row.size_sqft,
    monthly_price: usdFromCents(row.monthly_price_cents),
    monthly_price_cents: row.monthly_price_cents,
    min_term_months: row.min_term_months,
    max_term_months: row.max_term_months,
    availability_text: row.availability_text,
    best_for: row.best_for,
    utilities: row.utilities,
    buildout: row.buildout,
    image_url: row.image_url,
    amenities: JSON.parse(row.amenities_json || "[]"),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = {
  db,
  slugify,
  centsFromUsd,
  usdFromCents,
  sanitizeUser,
  normalizePropertyRow,
};

