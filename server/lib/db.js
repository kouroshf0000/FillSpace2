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
    strike_count INTEGER NOT NULL DEFAULT 0,
    frozen_until TEXT DEFAULT '',
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
    requests_paused INTEGER NOT NULL DEFAULT 0,
    cancellation_policy TEXT NOT NULL DEFAULT 'moderate',
    tax_rate_bps INTEGER NOT NULL DEFAULT 625,
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
    subtotal_cents INTEGER NOT NULL DEFAULT 0,
    tax_cents INTEGER NOT NULL DEFAULT 0,
    months_reserved INTEGER NOT NULL DEFAULT 0,
    response_deadline_at TEXT DEFAULT '',
    owner_response_at TEXT DEFAULT '',
    owner_response_type TEXT DEFAULT '',
    auto_accepted INTEGER NOT NULL DEFAULT 0,
    payment_deadline_at TEXT DEFAULT '',
    payment_link_token TEXT DEFAULT '',
    checkout_link_sent_at TEXT DEFAULT '',
    reminder_36_sent_at TEXT DEFAULT '',
    reminder_24_sent_at TEXT DEFAULT '',
    reminder_12_sent_at TEXT DEFAULT '',
    reminder_2_sent_at TEXT DEFAULT '',
    payment_completed_at TEXT DEFAULT '',
    documents_due_at TEXT DEFAULT '',
    documents_status TEXT NOT NULL DEFAULT 'not_started',
    tenant_documents_submitted_at TEXT DEFAULT '',
    owner_documents_submitted_at TEXT DEFAULT '',
    documents_reviewed_at TEXT DEFAULT '',
    documents_approved INTEGER NOT NULL DEFAULT 0,
    documents_notes TEXT DEFAULT '',
    payout_available_at TEXT DEFAULT '',
    payout_released_at TEXT DEFAULT '',
    stripe_transfer_id TEXT DEFAULT '',
    stripe_transfer_status TEXT DEFAULT '',
    cancellation_policy_snapshot TEXT NOT NULL DEFAULT 'moderate',
    security_deposit_cents INTEGER NOT NULL DEFAULT 0,
    security_deposit_status TEXT NOT NULL DEFAULT 'none',
    security_deposit_refund_id TEXT DEFAULT '',
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

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    reservation_id INTEGER,
    type TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'in_app',
    email_to TEXT NOT NULL DEFAULT '',
    email_sent INTEGER NOT NULL DEFAULT 0,
    read_at TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(reservation_id) REFERENCES reservations(id)
  );

  CREATE TABLE IF NOT EXISTS reservation_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reservation_id INTEGER NOT NULL,
    actor_user_id INTEGER,
    actor_role TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL,
    from_status TEXT NOT NULL DEFAULT '',
    to_status TEXT NOT NULL DEFAULT '',
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(reservation_id) REFERENCES reservations(id),
    FOREIGN KEY(actor_user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS reservation_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reservation_id INTEGER NOT NULL,
    uploaded_by_user_id INTEGER NOT NULL,
    party TEXT NOT NULL DEFAULT '',
    document_type TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL DEFAULT '',
    file_url TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'uploaded',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(reservation_id) REFERENCES reservations(id),
    FOREIGN KEY(uploaded_by_user_id) REFERENCES users(id)
  );
`);

function tableHasColumn(tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

function runUserMigrations() {
  if (!tableHasColumn("users", "strike_count")) {
    db.exec("ALTER TABLE users ADD COLUMN strike_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!tableHasColumn("users", "frozen_until")) {
    db.exec("ALTER TABLE users ADD COLUMN frozen_until TEXT DEFAULT ''");
  }
}

function runPropertyMigrations() {
  if (!tableHasColumn("properties", "requests_paused")) {
    db.exec("ALTER TABLE properties ADD COLUMN requests_paused INTEGER NOT NULL DEFAULT 0");
  }
  if (!tableHasColumn("properties", "cancellation_policy")) {
    db.exec("ALTER TABLE properties ADD COLUMN cancellation_policy TEXT NOT NULL DEFAULT 'moderate'");
  }
  if (!tableHasColumn("properties", "tax_rate_bps")) {
    db.exec("ALTER TABLE properties ADD COLUMN tax_rate_bps INTEGER NOT NULL DEFAULT 625");
  }
}

function runReservationMigrations() {
  if (!tableHasColumn("reservations", "security_deposit_cents")) {
    db.exec("ALTER TABLE reservations ADD COLUMN security_deposit_cents INTEGER NOT NULL DEFAULT 0");
  }
  if (!tableHasColumn("reservations", "security_deposit_status")) {
    db.exec("ALTER TABLE reservations ADD COLUMN security_deposit_status TEXT NOT NULL DEFAULT 'none'");
  }
  if (!tableHasColumn("reservations", "security_deposit_refund_id")) {
    db.exec("ALTER TABLE reservations ADD COLUMN security_deposit_refund_id TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "subtotal_cents")) {
    db.exec("ALTER TABLE reservations ADD COLUMN subtotal_cents INTEGER NOT NULL DEFAULT 0");
  }
  if (!tableHasColumn("reservations", "tax_cents")) {
    db.exec("ALTER TABLE reservations ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0");
  }
  if (!tableHasColumn("reservations", "months_reserved")) {
    db.exec("ALTER TABLE reservations ADD COLUMN months_reserved INTEGER NOT NULL DEFAULT 0");
  }
  if (!tableHasColumn("reservations", "response_deadline_at")) {
    db.exec("ALTER TABLE reservations ADD COLUMN response_deadline_at TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "owner_response_at")) {
    db.exec("ALTER TABLE reservations ADD COLUMN owner_response_at TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "owner_response_type")) {
    db.exec("ALTER TABLE reservations ADD COLUMN owner_response_type TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "auto_accepted")) {
    db.exec("ALTER TABLE reservations ADD COLUMN auto_accepted INTEGER NOT NULL DEFAULT 0");
  }
  if (!tableHasColumn("reservations", "payment_deadline_at")) {
    db.exec("ALTER TABLE reservations ADD COLUMN payment_deadline_at TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "payment_link_token")) {
    db.exec("ALTER TABLE reservations ADD COLUMN payment_link_token TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "checkout_link_sent_at")) {
    db.exec("ALTER TABLE reservations ADD COLUMN checkout_link_sent_at TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "reminder_36_sent_at")) {
    db.exec("ALTER TABLE reservations ADD COLUMN reminder_36_sent_at TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "reminder_24_sent_at")) {
    db.exec("ALTER TABLE reservations ADD COLUMN reminder_24_sent_at TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "reminder_12_sent_at")) {
    db.exec("ALTER TABLE reservations ADD COLUMN reminder_12_sent_at TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "reminder_2_sent_at")) {
    db.exec("ALTER TABLE reservations ADD COLUMN reminder_2_sent_at TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "payment_completed_at")) {
    db.exec("ALTER TABLE reservations ADD COLUMN payment_completed_at TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "documents_due_at")) {
    db.exec("ALTER TABLE reservations ADD COLUMN documents_due_at TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "documents_status")) {
    db.exec("ALTER TABLE reservations ADD COLUMN documents_status TEXT NOT NULL DEFAULT 'not_started'");
  }
  if (!tableHasColumn("reservations", "tenant_documents_submitted_at")) {
    db.exec("ALTER TABLE reservations ADD COLUMN tenant_documents_submitted_at TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "owner_documents_submitted_at")) {
    db.exec("ALTER TABLE reservations ADD COLUMN owner_documents_submitted_at TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "documents_reviewed_at")) {
    db.exec("ALTER TABLE reservations ADD COLUMN documents_reviewed_at TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "documents_approved")) {
    db.exec("ALTER TABLE reservations ADD COLUMN documents_approved INTEGER NOT NULL DEFAULT 0");
  }
  if (!tableHasColumn("reservations", "documents_notes")) {
    db.exec("ALTER TABLE reservations ADD COLUMN documents_notes TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "payout_available_at")) {
    db.exec("ALTER TABLE reservations ADD COLUMN payout_available_at TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "payout_released_at")) {
    db.exec("ALTER TABLE reservations ADD COLUMN payout_released_at TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "stripe_transfer_id")) {
    db.exec("ALTER TABLE reservations ADD COLUMN stripe_transfer_id TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "stripe_transfer_status")) {
    db.exec("ALTER TABLE reservations ADD COLUMN stripe_transfer_status TEXT DEFAULT ''");
  }
  if (!tableHasColumn("reservations", "cancellation_policy_snapshot")) {
    db.exec("ALTER TABLE reservations ADD COLUMN cancellation_policy_snapshot TEXT NOT NULL DEFAULT 'moderate'");
  }
}

runUserMigrations();
runPropertyMigrations();
runReservationMigrations();

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_reservations_status_response_deadline
    ON reservations(status, response_deadline_at);
  CREATE INDEX IF NOT EXISTS idx_reservations_status_payment_deadline
    ON reservations(status, payment_deadline_at);
  CREATE INDEX IF NOT EXISTS idx_reservations_payout_available
    ON reservations(status, payout_available_at);
  CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON notifications(user_id, created_at DESC);
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
    strike_count: Number(user.strike_count || 0),
    frozen_until: String(user.frozen_until || ""),
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
    requests_paused: Boolean(row.requests_paused),
    cancellation_policy: row.cancellation_policy || "moderate",
    tax_rate_bps: Number(row.tax_rate_bps || 625),
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

