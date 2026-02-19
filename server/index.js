require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const Stripe = require("stripe");
const { z } = require("zod");

const {
  db,
  slugify,
  centsFromUsd,
  sanitizeUser,
  normalizePropertyRow,
  usdFromCents,
} = require("./lib/db");

const app = express();

const PORT = Number(process.env.PORT || 4173);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || "fillspace-dev-secret-change-me";
const AUTH_COOKIE = "fillspace_auth";
const PLATFORM_FEE_RATE = 0.12;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const INQUIRY_FORWARD_URL = process.env.INQUIRY_FORWARD_URL || "https://formsubmit.co/kouroshf08@gmail.com";
const INQUIRY_FORWARD_ENABLED = String(process.env.INQUIRY_FORWARD_ENABLED || "true").toLowerCase() !== "false";

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

function issueAuthCookie(res, user) {
  const token = jwt.sign(
    {
      sub: user.id,
      role: user.role,
      email: user.email,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
  });
}

function getCurrentUserFromCookie(req) {
  const token = req.cookies[AUTH_COOKIE];
  if (!token) {
    return null;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const row = db
      .prepare("SELECT id, role, name, company, email, stripe_account_id, created_at FROM users WHERE id = ?")
      .get(payload.sub);
    return sanitizeUser(row);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required." });
  }
  return next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required." });
    }
    if (req.user.role !== role) {
      return res.status(403).json({ error: `Only ${role} users can access this resource.` });
    }
    return next();
  };
}

function runAsync(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function calculateDurationInMonths(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end <= start) {
    throw new Error("Invalid reservation dates.");
  }
  const totalDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
  return Math.max(1, Math.ceil(totalDays / 30));
}

function currency(valueInCents) {
  return `$${usdFromCents(valueInCents).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const authInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  company: z.string().trim().max(120).optional().default(""),
  email: z.string().trim().email().max(180),
  password: z.string().min(8).max(120),
  role: z.enum(["owner", "tenant"]),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(180),
  password: z.string().min(1).max(120),
  role: z.enum(["owner", "tenant"]).optional(),
});

const propertySchema = z.object({
  title: z.string().trim().min(4).max(120),
  description: z.string().trim().min(20).max(2500),
  location: z.string().trim().min(4).max(180),
  city: z.string().trim().max(80).optional().default(""),
  state: z.string().trim().max(30).optional().default(""),
  size_sqft: z.coerce.number().int().min(100).max(100000),
  monthly_price: z.coerce.number().min(100).max(1000000),
  min_term_months: z.coerce.number().int().min(1).max(24),
  max_term_months: z.coerce.number().int().min(1).max(24),
  availability_text: z.string().trim().max(120).optional().default("Available now"),
  best_for: z.string().trim().max(160).optional().default(""),
  utilities: z.string().trim().max(200).optional().default(""),
  buildout: z.string().trim().max(200).optional().default(""),
  image_url: z.string().trim().url().or(z.literal("")).optional().default(""),
  status: z.enum(["active", "draft", "paused"]).optional().default("active"),
  amenities: z.array(z.string().trim().min(2).max(40)).max(12).optional().default([]),
});

const reservationSchema = z.object({
  propertyId: z.coerce.number().int().positive(),
  startDate: z.string().trim().min(10),
  endDate: z.string().trim().min(10),
});

const propertyStatusSchema = z.object({
  status: z.enum(["active", "draft", "paused"]),
});

const inquirySchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(180),
  company: z.string().trim().max(160).optional().default(""),
  goal: z.string().trim().min(2).max(80),
  timeline: z.string().trim().min(2).max(80),
  budget: z.string().trim().max(120).optional().default(""),
  message: z.string().trim().min(8).max(4000),
  property: z.string().trim().max(180).optional().default(""),
  location: z.string().trim().max(180).optional().default(""),
  source: z.string().trim().max(120).optional().default("website"),
  subject: z.string().trim().max(200).optional().default("New FillSpace inquiry"),
});

app.use(cookieParser());

app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  runAsync(async (req, res) => {
    if (!stripe) {
      return res.status(501).json({ error: "Stripe is not configured on this server." });
    }

    let event;
    if (STRIPE_WEBHOOK_SECRET) {
      const signature = req.headers["stripe-signature"];
      try {
        event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
      } catch (error) {
        return res.status(400).json({ error: `Webhook signature verification failed: ${error.message}` });
      }
    } else {
      event = JSON.parse(req.body.toString("utf8"));
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      db.prepare(`
        UPDATE reservations
        SET status = 'confirmed',
            stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
            updated_at = CURRENT_TIMESTAMP
        WHERE stripe_checkout_session_id = ?
      `).run(session.payment_intent || "", session.id);
    }

    if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      db.prepare(`
        UPDATE reservations
        SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE stripe_checkout_session_id = ?
      `).run(session.id);
    }

    if (event.type === "payment_intent.payment_failed") {
      const paymentIntent = event.data.object;
      db.prepare(`
        UPDATE reservations
        SET status = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE stripe_payment_intent_id = ?
      `).run(paymentIntent.id);
    }

    return res.json({ received: true });
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  req.user = getCurrentUserFromCookie(req);
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    stripeConfigured: Boolean(stripe),
    timestamp: new Date().toISOString(),
  });
});

app.post(
  "/api/auth/register",
  runAsync(async (req, res) => {
    const parsed = authInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input." });
    }

    const data = parsed.data;
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(data.email);
    if (existing) {
      return res.status(409).json({ error: "Email already in use." });
    }

    const passwordHash = await bcrypt.hash(data.password, 10);
    const insert = db.prepare(`
      INSERT INTO users (role, name, company, email, password_hash)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = insert.run(data.role, data.name, data.company || "", data.email, passwordHash);

    const user = sanitizeUser(
      db
        .prepare("SELECT id, role, name, company, email, stripe_account_id, created_at FROM users WHERE id = ?")
        .get(result.lastInsertRowid)
    );
    issueAuthCookie(res, user);
    return res.status(201).json({ user });
  })
);

app.post(
  "/api/auth/login",
  runAsync(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid input." });
    }

    const data = parsed.data;
    const userRow = db.prepare("SELECT * FROM users WHERE email = ?").get(data.email);
    if (!userRow) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    if (data.role && userRow.role !== data.role) {
      return res.status(403).json({ error: `This account is not a ${data.role}.` });
    }

    const passwordOk = await bcrypt.compare(data.password, userRow.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const user = sanitizeUser(userRow);
    issueAuthCookie(res, user);
    return res.json({ user });
  })
);

app.post("/api/auth/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.user) {
    return res.status(401).json({ user: null });
  }
  return res.json({ user: req.user });
});

app.post(
  "/api/inquiries",
  runAsync(async (req, res) => {
    const parsed = inquirySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid inquiry payload." });
    }

    const data = parsed.data;
    const insertResult = db.prepare(`
      INSERT INTO inquiries (
        name, email, company, goal, timeline, budget, message,
        property_interest, property_location, source, subject
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.name,
      data.email,
      data.company || "",
      data.goal,
      data.timeline,
      data.budget || "",
      data.message,
      data.property || "",
      data.location || "",
      data.source || "website",
      data.subject || "New FillSpace inquiry"
    );

    const inquiryId = Number(insertResult.lastInsertRowid);
    let forwarded = false;
    let forwardStatus = "stored-only";

    if (INQUIRY_FORWARD_ENABLED && INQUIRY_FORWARD_URL) {
      try {
        const payload = new URLSearchParams({
          Name: data.name,
          Email: data.email,
          Company: data.company || "",
          "Primary goal": data.goal,
          Timeline: data.timeline,
          "Estimated monthly budget": data.budget || "",
          "Property of interest": data.property || "",
          "Property location": data.location || "",
          Source: data.source || "website",
          Message: data.message,
          _subject: data.subject || "New FillSpace inquiry",
          _template: "table",
          _captcha: "false",
        });

        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort(), 8000);
        const forwardRes = await fetch(INQUIRY_FORWARD_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: payload,
          signal: abortController.signal,
        });
        clearTimeout(timeout);

        if (forwardRes.ok) {
          forwarded = true;
          forwardStatus = "forwarded";
        } else {
          forwardStatus = `forward-http-${forwardRes.status}`;
        }
      } catch {
        forwardStatus = "forward-failed";
      }
    }

    db.prepare(`
      UPDATE inquiries
      SET email_forwarded = ?, forward_status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(forwarded ? 1 : 0, forwardStatus, inquiryId);

    const responseMessage = forwarded
      ? "Complete. Your request has been sent."
      : "Complete. Your request was saved and is queued for follow-up.";
    return res.status(forwarded ? 201 : 202).json({
      ok: true,
      inquiry_id: inquiryId,
      status: forwarded ? "complete" : "stored",
      message: responseMessage,
    });
  })
);

app.get(
  "/api/properties",
  runAsync(async (_req, res) => {
    const rows = db.prepare(`
      SELECT
        p.*,
        u.name AS owner_name,
        u.company AS owner_company
      FROM properties p
      JOIN users u ON u.id = p.owner_id
      WHERE p.status = 'active'
      ORDER BY p.created_at DESC
    `).all();

    const properties = rows.map((row) => ({
      ...normalizePropertyRow(row),
      owner_name: row.owner_name,
      owner_company: row.owner_company,
    }));

    return res.json({ properties });
  })
);

app.get(
  "/api/properties/:id",
  runAsync(async (req, res) => {
    const rawId = req.params.id;
    const isNumeric = /^\d+$/.test(String(rawId));
    const row = isNumeric
      ? db.prepare("SELECT * FROM properties WHERE id = ?").get(Number(rawId))
      : db.prepare("SELECT * FROM properties WHERE slug = ?").get(rawId);

    if (!row) {
      return res.status(404).json({ error: "Property not found." });
    }
    return res.json({ property: normalizePropertyRow(row) });
  })
);

app.get(
  "/api/owner/properties",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const rows = db
      .prepare("SELECT * FROM properties WHERE owner_id = ? ORDER BY created_at DESC")
      .all(req.user.id);
    return res.json({ properties: rows.map(normalizePropertyRow) });
  })
);

app.post(
  "/api/owner/properties",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const parsed = propertySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid property payload." });
    }
    const data = parsed.data;

    if (data.max_term_months < data.min_term_months) {
      return res.status(400).json({ error: "Max term must be greater than or equal to min term." });
    }

    let slug = slugify(data.title);
    if (!slug) {
      slug = `property-${crypto.randomBytes(3).toString("hex")}`;
    }

    const existing = db.prepare("SELECT id FROM properties WHERE slug = ?").get(slug);
    if (existing) {
      slug = `${slug}-${crypto.randomBytes(2).toString("hex")}`;
    }

    const result = db.prepare(`
      INSERT INTO properties (
        owner_id, slug, title, description, location, city, state, size_sqft,
        monthly_price_cents, min_term_months, max_term_months, availability_text,
        best_for, utilities, buildout, image_url, amenities_json, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      slug,
      data.title,
      data.description,
      data.location,
      data.city,
      data.state,
      data.size_sqft,
      centsFromUsd(data.monthly_price),
      data.min_term_months,
      data.max_term_months,
      data.availability_text,
      data.best_for,
      data.utilities,
      data.buildout,
      data.image_url,
      JSON.stringify(data.amenities),
      data.status
    );

    const property = db.prepare("SELECT * FROM properties WHERE id = ?").get(result.lastInsertRowid);
    return res.status(201).json({ property: normalizePropertyRow(property) });
  })
);

app.put(
  "/api/owner/properties/:id",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const propertyId = Number(req.params.id);
    if (!Number.isFinite(propertyId)) {
      return res.status(400).json({ error: "Invalid property id." });
    }

    const existing = db.prepare("SELECT * FROM properties WHERE id = ? AND owner_id = ?").get(propertyId, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: "Property not found for this owner." });
    }

    const parsed = propertySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid property payload." });
    }
    const data = parsed.data;

    if (data.max_term_months < data.min_term_months) {
      return res.status(400).json({ error: "Max term must be greater than or equal to min term." });
    }

    db.prepare(`
      UPDATE properties
      SET
        title = ?,
        description = ?,
        location = ?,
        city = ?,
        state = ?,
        size_sqft = ?,
        monthly_price_cents = ?,
        min_term_months = ?,
        max_term_months = ?,
        availability_text = ?,
        best_for = ?,
        utilities = ?,
        buildout = ?,
        image_url = ?,
        amenities_json = ?,
        status = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND owner_id = ?
    `).run(
      data.title,
      data.description,
      data.location,
      data.city,
      data.state,
      data.size_sqft,
      centsFromUsd(data.monthly_price),
      data.min_term_months,
      data.max_term_months,
      data.availability_text,
      data.best_for,
      data.utilities,
      data.buildout,
      data.image_url,
      JSON.stringify(data.amenities),
      data.status,
      propertyId,
      req.user.id
    );

    const updated = db.prepare("SELECT * FROM properties WHERE id = ?").get(propertyId);
    return res.json({ property: normalizePropertyRow(updated) });
  })
);

app.patch(
  "/api/owner/properties/:id/status",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const propertyId = Number(req.params.id);
    if (!Number.isFinite(propertyId)) {
      return res.status(400).json({ error: "Invalid property id." });
    }

    const parsed = propertyStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid status payload." });
    }

    const existing = db.prepare("SELECT * FROM properties WHERE id = ? AND owner_id = ?").get(propertyId, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: "Property not found for this owner." });
    }

    db.prepare(`
      UPDATE properties
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND owner_id = ?
    `).run(parsed.data.status, propertyId, req.user.id);

    const updated = db.prepare("SELECT * FROM properties WHERE id = ?").get(propertyId);
    return res.json({ property: normalizePropertyRow(updated) });
  })
);

app.delete(
  "/api/owner/properties/:id",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const propertyId = Number(req.params.id);
    if (!Number.isFinite(propertyId)) {
      return res.status(400).json({ error: "Invalid property id." });
    }

    const existing = db.prepare("SELECT * FROM properties WHERE id = ? AND owner_id = ?").get(propertyId, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: "Property not found for this owner." });
    }

    const reservationCount = db
      .prepare("SELECT COUNT(*) AS count FROM reservations WHERE property_id = ?")
      .get(propertyId)?.count;
    if (Number(reservationCount || 0) > 0) {
      return res.status(409).json({
        error: "This listing has reservation history and cannot be deleted. Pause it instead.",
      });
    }

    db.prepare("DELETE FROM favorites WHERE property_id = ?").run(propertyId);
    db.prepare("DELETE FROM properties WHERE id = ? AND owner_id = ?").run(propertyId, req.user.id);
    return res.json({ ok: true });
  })
);

app.get(
  "/api/owner/analytics",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const summary = db.prepare(`
      SELECT
        COUNT(*) AS total_properties,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_properties
      FROM properties
      WHERE owner_id = ?
    `).get(req.user.id);

    const reservationSummary = db.prepare(`
      SELECT
        COUNT(*) AS total_reservations,
        SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_reservations,
        COALESCE(SUM(CASE WHEN status = 'confirmed' THEN total_cents ELSE 0 END), 0) AS gross_cents,
        COALESCE(SUM(CASE WHEN status = 'confirmed' THEN owner_payout_cents ELSE 0 END), 0) AS payout_cents
      FROM reservations
      WHERE owner_id = ?
    `).get(req.user.id);

    const propertyPerformance = db.prepare(`
      SELECT
        p.id,
        p.title,
        p.slug,
        p.monthly_price_cents,
        COUNT(r.id) AS reservation_count,
        COALESCE(SUM(CASE WHEN r.status = 'confirmed' THEN r.total_cents ELSE 0 END), 0) AS revenue_cents
      FROM properties p
      LEFT JOIN reservations r ON r.property_id = p.id
      WHERE p.owner_id = ?
      GROUP BY p.id
      ORDER BY revenue_cents DESC
      LIMIT 8
    `).all(req.user.id);

    return res.json({
      summary: {
        total_properties: summary.total_properties || 0,
        active_properties: summary.active_properties || 0,
        total_reservations: reservationSummary.total_reservations || 0,
        confirmed_reservations: reservationSummary.confirmed_reservations || 0,
        gross_revenue: usdFromCents(reservationSummary.gross_cents || 0),
        owner_payouts: usdFromCents(reservationSummary.payout_cents || 0),
      },
      property_performance: propertyPerformance.map((item) => ({
        ...item,
        monthly_price: usdFromCents(item.monthly_price_cents),
        revenue: usdFromCents(item.revenue_cents),
      })),
    });
  })
);

app.get(
  "/api/owner/finance",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const rows = db.prepare(`
      SELECT
        r.id,
        r.status,
        r.start_date,
        r.end_date,
        r.total_cents,
        r.platform_fee_cents,
        r.owner_payout_cents,
        r.created_at,
        p.title AS property_title,
        u.name AS tenant_name,
        u.email AS tenant_email
      FROM reservations r
      JOIN properties p ON p.id = r.property_id
      JOIN users u ON u.id = r.tenant_id
      WHERE r.owner_id = ?
      ORDER BY r.created_at DESC
      LIMIT 50
    `).all(req.user.id);

    return res.json({
      transactions: rows.map((row) => ({
        ...row,
        total: usdFromCents(row.total_cents),
        platform_fee: usdFromCents(row.platform_fee_cents),
        owner_payout: usdFromCents(row.owner_payout_cents),
      })),
    });
  })
);

app.get("/api/owner/legal", requireRole("owner"), (_req, res) => {
  res.json({
    documents: [
      {
        id: "lease-template",
        name: "Standard Mid-Term Lease Terms",
        category: "Legal",
        updated_at: "2026-01-14",
      },
      {
        id: "insurance-guidelines",
        name: "Insurance Coverage Guidelines",
        category: "Risk",
        updated_at: "2026-01-20",
      },
      {
        id: "tax-overview",
        name: "Owner Tax Reporting Overview",
        category: "Tax",
        updated_at: "2026-02-01",
      },
    ],
  });
});

app.get(
  "/api/owner/inquiries",
  requireRole("owner"),
  runAsync(async (_req, res) => {
    const rows = db.prepare(`
      SELECT
        id,
        name,
        email,
        company,
        goal,
        timeline,
        budget,
        message,
        property_interest,
        property_location,
        source,
        subject,
        email_forwarded,
        forward_status,
        created_at
      FROM inquiries
      ORDER BY created_at DESC
      LIMIT 100
    `).all();
    return res.json({
      inquiries: rows.map((row) => ({
        ...row,
        email_forwarded: Boolean(row.email_forwarded),
      })),
    });
  })
);

app.post(
  "/api/owner/stripe/connect",
  requireRole("owner"),
  runAsync(async (req, res) => {
    if (!stripe) {
      return res.status(501).json({
        error: "Stripe is not configured. Add STRIPE_SECRET_KEY in your environment.",
      });
    }

    let accountId = req.user.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        country: "US",
        email: req.user.email,
        business_type: "company",
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });
      accountId = account.id;
      db.prepare("UPDATE users SET stripe_account_id = ? WHERE id = ?").run(accountId, req.user.id);
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${BASE_URL}/dashboard-owner.html?stripe=refresh`,
      return_url: `${BASE_URL}/dashboard-owner.html?stripe=connected`,
      type: "account_onboarding",
    });

    return res.json({
      stripe_account_id: accountId,
      onboarding_url: accountLink.url,
    });
  })
);

app.get(
  "/api/owner/dashboard",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const properties = db.prepare("SELECT * FROM properties WHERE owner_id = ? ORDER BY created_at DESC").all(req.user.id);
    const analytics = db.prepare(`
      SELECT
        COUNT(*) AS total_properties,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_properties
      FROM properties
      WHERE owner_id = ?
    `).get(req.user.id);
    const reservations = db.prepare(`
      SELECT
        r.id,
        r.status,
        r.start_date,
        r.end_date,
        r.total_cents,
        r.platform_fee_cents,
        r.owner_payout_cents,
        r.created_at,
        p.title AS property_title,
        u.name AS tenant_name
      FROM reservations r
      JOIN properties p ON p.id = r.property_id
      JOIN users u ON u.id = r.tenant_id
      WHERE r.owner_id = ?
      ORDER BY r.created_at DESC
      LIMIT 20
    `).all(req.user.id);

    return res.json({
      user: req.user,
      stripe_connected: Boolean(req.user.stripe_account_id),
      analytics: {
        total_properties: analytics.total_properties || 0,
        active_properties: analytics.active_properties || 0,
      },
      properties: properties.map(normalizePropertyRow),
      reservations: reservations.map((row) => ({
        ...row,
        total: usdFromCents(row.total_cents),
        platform_fee: usdFromCents(row.platform_fee_cents),
        owner_payout: usdFromCents(row.owner_payout_cents),
      })),
    });
  })
);

app.get(
  "/api/tenant/favorites",
  requireRole("tenant"),
  runAsync(async (req, res) => {
    const rows = db.prepare(`
      SELECT p.*
      FROM favorites f
      JOIN properties p ON p.id = f.property_id
      WHERE f.tenant_id = ?
      ORDER BY f.created_at DESC
    `).all(req.user.id);
    return res.json({ favorites: rows.map(normalizePropertyRow) });
  })
);

app.post(
  "/api/tenant/favorites/:propertyId",
  requireRole("tenant"),
  runAsync(async (req, res) => {
    const propertyId = Number(req.params.propertyId);
    if (!Number.isFinite(propertyId)) {
      return res.status(400).json({ error: "Invalid property id." });
    }
    const property = db.prepare("SELECT id FROM properties WHERE id = ? AND status = 'active'").get(propertyId);
    if (!property) {
      return res.status(404).json({ error: "Property not found." });
    }

    db.prepare(`
      INSERT OR IGNORE INTO favorites (tenant_id, property_id)
      VALUES (?, ?)
    `).run(req.user.id, propertyId);

    return res.json({ ok: true });
  })
);

app.delete(
  "/api/tenant/favorites/:propertyId",
  requireRole("tenant"),
  runAsync(async (req, res) => {
    const propertyId = Number(req.params.propertyId);
    if (!Number.isFinite(propertyId)) {
      return res.status(400).json({ error: "Invalid property id." });
    }

    db.prepare("DELETE FROM favorites WHERE tenant_id = ? AND property_id = ?").run(req.user.id, propertyId);
    return res.json({ ok: true });
  })
);

app.get(
  "/api/tenant/reservations",
  requireRole("tenant"),
  runAsync(async (req, res) => {
    const rows = db.prepare(`
      SELECT
        r.*,
        p.title AS property_title,
        p.location AS property_location
      FROM reservations r
      JOIN properties p ON p.id = r.property_id
      WHERE r.tenant_id = ?
      ORDER BY r.created_at DESC
    `).all(req.user.id);

    const now = new Date().toISOString().slice(0, 10);
    const upcoming = [];
    const history = [];

    for (const row of rows) {
      const normalized = {
        ...row,
        total: usdFromCents(row.total_cents),
        platform_fee: usdFromCents(row.platform_fee_cents),
      };
      if (row.end_date >= now && row.status !== "cancelled" && row.status !== "failed") {
        upcoming.push(normalized);
      } else {
        history.push(normalized);
      }
    }

    return res.json({ upcoming, history });
  })
);

app.get(
  "/api/tenant/dashboard",
  requireRole("tenant"),
  runAsync(async (req, res) => {
    const favorites = db.prepare(`
      SELECT p.*
      FROM favorites f
      JOIN properties p ON p.id = f.property_id
      WHERE f.tenant_id = ?
      ORDER BY f.created_at DESC
      LIMIT 12
    `).all(req.user.id);

    const reservations = db.prepare(`
      SELECT
        r.id,
        r.status,
        r.start_date,
        r.end_date,
        r.total_cents,
        r.platform_fee_cents,
        r.created_at,
        p.title AS property_title,
        p.location AS property_location
      FROM reservations r
      JOIN properties p ON p.id = r.property_id
      WHERE r.tenant_id = ?
      ORDER BY r.created_at DESC
      LIMIT 40
    `).all(req.user.id);

    const financeSummary = db.prepare(`
      SELECT
        COUNT(*) AS reservation_count,
        COALESCE(SUM(CASE WHEN status = 'confirmed' THEN total_cents ELSE 0 END), 0) AS confirmed_total_cents,
        COALESCE(SUM(CASE WHEN status = 'confirmed' THEN platform_fee_cents ELSE 0 END), 0) AS platform_fee_total_cents
      FROM reservations
      WHERE tenant_id = ?
    `).get(req.user.id);

    return res.json({
      user: req.user,
      reservations: reservations.map((row) => ({
        ...row,
        total: usdFromCents(row.total_cents),
        platform_fee: usdFromCents(row.platform_fee_cents),
      })),
      favorites: favorites.map(normalizePropertyRow),
      finance: {
        reservation_count: financeSummary.reservation_count || 0,
        confirmed_total: usdFromCents(financeSummary.confirmed_total_cents || 0),
        platform_fees: usdFromCents(financeSummary.platform_fee_total_cents || 0),
        tax_year: new Date().getFullYear(),
      },
    });
  })
);

app.post(
  "/api/payments/checkout",
  requireRole("tenant"),
  runAsync(async (req, res) => {
    if (!stripe) {
      return res.status(501).json({
        error:
          "Stripe is not configured. Add STRIPE_SECRET_KEY to enable marketplace checkout and owner payouts.",
      });
    }

    const parsed = reservationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid reservation payload." });
    }
    const data = parsed.data;

    const property = db.prepare("SELECT * FROM properties WHERE id = ? AND status = 'active'").get(data.propertyId);
    if (!property) {
      return res.status(404).json({ error: "Property not found." });
    }
    if (property.owner_id === req.user.id) {
      return res.status(400).json({ error: "Owners cannot reserve their own listings." });
    }

    const owner = db.prepare("SELECT id, email, stripe_account_id FROM users WHERE id = ?").get(property.owner_id);
    if (!owner?.stripe_account_id) {
      return res.status(409).json({
        error: "Owner has not connected Stripe payouts yet.",
      });
    }

    const durationMonths = calculateDurationInMonths(data.startDate, data.endDate);
    if (durationMonths < property.min_term_months || durationMonths > property.max_term_months) {
      return res.status(400).json({
        error: `Reservation term must be between ${property.min_term_months} and ${property.max_term_months} months.`,
      });
    }

    const totalCents = property.monthly_price_cents * durationMonths;
    const platformFeeCents = Math.round(totalCents * PLATFORM_FEE_RATE);
    const ownerPayoutCents = totalCents - platformFeeCents;

    const reservationInsert = db.prepare(`
      INSERT INTO reservations (
        property_id, tenant_id, owner_id, start_date, end_date, status,
        total_cents, platform_fee_cents, owner_payout_cents
      )
      VALUES (?, ?, ?, ?, ?, 'payment_pending', ?, ?, ?)
    `);
    const insertResult = reservationInsert.run(
      property.id,
      req.user.id,
      property.owner_id,
      data.startDate,
      data.endDate,
      totalCents,
      platformFeeCents,
      ownerPayoutCents
    );

    const reservationId = Number(insertResult.lastInsertRowid);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: req.user.email,
      success_url: `${BASE_URL}/dashboard-tenant.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/dashboard-tenant.html?checkout=cancelled`,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: totalCents,
            product_data: {
              name: `${property.title} booking (${durationMonths} month${durationMonths > 1 ? "s" : ""})`,
              description: `${data.startDate} to ${data.endDate}`,
            },
          },
        },
      ],
      payment_intent_data: {
        application_fee_amount: platformFeeCents,
        transfer_data: {
          destination: owner.stripe_account_id,
        },
        metadata: {
          reservationId: String(reservationId),
          propertyId: String(property.id),
          tenantId: String(req.user.id),
          ownerId: String(property.owner_id),
        },
      },
      metadata: {
        reservationId: String(reservationId),
        propertyId: String(property.id),
        tenantId: String(req.user.id),
      },
    });

    db.prepare(`
      UPDATE reservations
      SET stripe_checkout_session_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(session.id, reservationId);

    return res.json({
      reservation_id: reservationId,
      checkout_url: session.url,
      total: currency(totalCents),
      platform_fee: currency(platformFeeCents),
      owner_payout: currency(ownerPayoutCents),
    });
  })
);

app.get(
  "/api/payments/quote",
  requireAuth,
  runAsync(async (req, res) => {
    const propertyId = Number(req.query.propertyId);
    const startDate = String(req.query.startDate || "");
    const endDate = String(req.query.endDate || "");

    if (!Number.isFinite(propertyId) || !startDate || !endDate) {
      return res.status(400).json({ error: "propertyId, startDate, and endDate are required." });
    }

    const property = db.prepare("SELECT * FROM properties WHERE id = ?").get(propertyId);
    if (!property) {
      return res.status(404).json({ error: "Property not found." });
    }

    const months = calculateDurationInMonths(startDate, endDate);
    const totalCents = property.monthly_price_cents * months;
    const platformFeeCents = Math.round(totalCents * PLATFORM_FEE_RATE);
    const ownerPayoutCents = totalCents - platformFeeCents;

    return res.json({
      months,
      total: usdFromCents(totalCents),
      platform_fee: usdFromCents(platformFeeCents),
      owner_payout: usdFromCents(ownerPayoutCents),
    });
  })
);

app.post("/api/dev/seed-reservation", requireRole("tenant"), (req, res) => {
  const property = db.prepare("SELECT * FROM properties WHERE status = 'active' ORDER BY id ASC LIMIT 1").get();
  if (!property) {
    return res.status(404).json({ error: "No active properties to seed." });
  }

  const ownerId = property.owner_id;
  const totalCents = property.monthly_price_cents;
  const fee = Math.round(totalCents * PLATFORM_FEE_RATE);
  const payout = totalCents - fee;

  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const end = new Date(today.getFullYear(), today.getMonth() + 2, 1);
  const toDateString = (d) => d.toISOString().slice(0, 10);

  db.prepare(`
    INSERT INTO reservations (
      property_id, tenant_id, owner_id, start_date, end_date, status,
      total_cents, platform_fee_cents, owner_payout_cents, stripe_checkout_session_id
    )
    VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)
  `).run(
    property.id,
    req.user.id,
    ownerId,
    toDateString(start),
    toDateString(end),
    totalCents,
    fee,
    payout,
    `manual_seed_${crypto.randomBytes(4).toString("hex")}`
  );

  return res.json({ ok: true });
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found." });
});

app.use(express.static(path.join(__dirname, "..")));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, () => {
  console.log(`FillSpace server running at ${BASE_URL}`);
  console.log(`Stripe configured: ${stripe ? "yes" : "no"}`);
});

