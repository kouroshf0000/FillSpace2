require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
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
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const INQUIRY_EMAIL_FROM = process.env.INQUIRY_EMAIL_FROM || SMTP_USER || "no-reply@fillspace.local";
const INQUIRY_EMAIL_TO = process.env.INQUIRY_EMAIL_TO || "kouroshf08@gmail.com";
const LISTING_NOTIFY_EMAIL_TO = process.env.LISTING_NOTIFY_EMAIL_TO || INQUIRY_EMAIL_TO;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SECURITY_DEPOSIT_USD_VALUE = Number(process.env.SECURITY_DEPOSIT_USD || 500);
const SECURITY_DEPOSIT_USD = Number.isFinite(SECURITY_DEPOSIT_USD_VALUE)
  ? Math.max(0, SECURITY_DEPOSIT_USD_VALUE)
  : 500;
const SECURITY_DEPOSIT_CENTS = Math.round(SECURITY_DEPOSIT_USD * 100);

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const inquiryMailer =
  SMTP_HOST && SMTP_USER && SMTP_PASS
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: {
          user: SMTP_USER,
          pass: SMTP_PASS,
        },
      })
    : null;

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
    secure: IS_PRODUCTION,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PRODUCTION,
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
    return res.status(401).json({ error: "Please sign in to continue." });
  }
  return next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Please sign in to continue." });
    }
    if (req.user.role !== role) {
      return res.status(403).json({ error: `This action is only available to ${role} accounts.` });
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
    return null;
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

async function sendInquiryEmailDirect(data) {
  if (!inquiryMailer) {
    return false;
  }
  const subject = data.subject || "New FillSpace inquiry";
  const lines = [
    `Name: ${data.name}`,
    `Email: ${data.email}`,
    `Company: ${data.company || "-"}`,
    `Goal: ${data.goal}`,
    `Timeline: ${data.timeline}`,
    `Budget: ${data.budget || "-"}`,
    `Property: ${data.property || "-"}`,
    `Location: ${data.location || "-"}`,
    `Source: ${data.source || "website"}`,
    "",
    "Message:",
    data.message,
  ];

  await inquiryMailer.sendMail({
    from: INQUIRY_EMAIL_FROM,
    to: INQUIRY_EMAIL_TO,
    replyTo: data.email,
    subject,
    text: lines.join("\n"),
  });
  return true;
}

async function sendOwnerListingNotification(owner, property) {
  if (!inquiryMailer) {
    return false;
  }
  const monthlyPrice = Number(property?.monthlyPrice ?? property?.monthly_price ?? 0);
  const minTerm = property?.minTermMonths ?? property?.min_term_months ?? "-";
  const maxTerm = property?.maxTermMonths ?? property?.max_term_months ?? "-";
  const createdAt = property?.createdAt ?? property?.created_at ?? new Date().toISOString();
  const lines = [
    "A new owner listing was published on FillSpace.",
    "",
    `Owner: ${owner?.name || "-"} (${owner?.email || "-"})`,
    `Company: ${owner?.company || "-"}`,
    `Title: ${property?.title || "-"}`,
    `Location: ${property?.location || "-"}`,
    `Price: $${monthlyPrice.toLocaleString("en-US")}/mo`,
    `Term: ${minTerm}-${maxTerm} months`,
    `Listing ID: ${property?.id || "-"}`,
    `Slug: ${property?.slug || "-"}`,
    `Created: ${createdAt}`,
  ];

  await inquiryMailer.sendMail({
    from: INQUIRY_EMAIL_FROM,
    to: LISTING_NOTIFY_EMAIL_TO,
    subject: `New owner listing: ${property?.title || "Untitled listing"}`,
    text: lines.join("\n"),
  });
  return true;
}

function summarizeStripeRequirements(account) {
  const currentlyDue = Array.isArray(account?.requirements?.currently_due)
    ? account.requirements.currently_due
    : [];
  const pastDue = Array.isArray(account?.requirements?.past_due) ? account.requirements.past_due : [];
  const allDue = [...currentlyDue, ...pastDue].filter(Boolean);
  return Array.from(new Set(allDue)).slice(0, 10);
}

function stripeStatusFromAccount(account) {
  if (!account) {
    return {
      configured: Boolean(stripe),
      connected: false,
      ready: false,
      details_submitted: false,
      charges_enabled: false,
      payouts_enabled: false,
      requirements_due: [],
      disabled_reason: "",
      account_id: "",
    };
  }
  return {
    configured: Boolean(stripe),
    connected: true,
    ready: Boolean(account.details_submitted && account.charges_enabled && account.payouts_enabled),
    details_submitted: Boolean(account.details_submitted),
    charges_enabled: Boolean(account.charges_enabled),
    payouts_enabled: Boolean(account.payouts_enabled),
    requirements_due: summarizeStripeRequirements(account),
    disabled_reason: String(account?.requirements?.disabled_reason || ""),
    account_id: String(account.id || ""),
  };
}

async function getStripeStatusForAccountId(accountId) {
  if (!stripe) {
    return {
      configured: false,
      connected: Boolean(accountId),
      ready: false,
      details_submitted: false,
      charges_enabled: false,
      payouts_enabled: false,
      requirements_due: [],
      disabled_reason: "",
      account_id: String(accountId || ""),
    };
  }
  if (!accountId) {
    return stripeStatusFromAccount(null);
  }
  try {
    const account = await stripe.accounts.retrieve(accountId);
    return stripeStatusFromAccount(account);
  } catch {
    return {
      configured: true,
      connected: true,
      ready: false,
      details_submitted: false,
      charges_enabled: false,
      payouts_enabled: false,
      requirements_due: [],
      disabled_reason: "account_unavailable",
      account_id: String(accountId || ""),
    };
  }
}

async function getStripeStatusForUser(user) {
  return getStripeStatusForAccountId(user?.stripe_account_id || "");
}

function stripeSetupMessage(status) {
  if (!status?.configured) {
    return "Payout setup is temporarily unavailable. Please try again later.";
  }
  if (!status?.connected) {
    return "Connect Stripe and complete onboarding before you can list properties.";
  }
  if (!status?.ready) {
    return "Finish Stripe onboarding before listing properties or accepting bookings.";
  }
  return "";
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function feeAmountFromSubtotal(subtotalCents) {
  const cents = Number(subtotalCents || 0);
  if (!Number.isFinite(cents) || cents <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(cents * PLATFORM_FEE_RATE));
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ROLE_OPTIONS = new Set(["owner", "tenant"]);
const PROPERTY_STATUS_OPTIONS = new Set(["active", "draft", "paused"]);
const FIELD_LABELS = {
  name: "your name",
  company: "company name",
  email: "an email address",
  password: "a password",
  role: "an account type",
  title: "a property title",
  description: "a description",
  location: "a location",
  city: "a city",
  state: "a state",
  size_sqft: "the size in square feet",
  monthly_price: "the monthly rent",
  min_term_months: "the minimum term",
  max_term_months: "the maximum term",
  availability_text: "availability details",
  best_for: "best-for details",
  utilities: "utility details",
  buildout: "buildout details",
  image_url: "a photo URL",
  amenities: "valid amenities",
  propertyId: "a property",
  startDate: "a start date",
  endDate: "an end date",
  goal: "a primary goal",
  timeline: "a timeline",
  budget: "a budget",
  message: "a message",
  property: "a property",
  source: "a source",
  subject: "a subject",
  status: "a status",
};

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function formatValidationError(zodError, fallbackMessage = "Please review your entries and try again.") {
  const issue = zodError?.issues?.[0];
  if (!issue) {
    return fallbackMessage;
  }

  const field = Array.isArray(issue.path) && issue.path.length ? String(issue.path[0]) : "";
  const fieldLabel = FIELD_LABELS[field] || "this field";

  if (issue.code === "invalid_type") {
    if (issue.input === undefined || issue.received === "undefined") {
      return `Please enter ${fieldLabel}.`;
    }
    return `Please check ${fieldLabel} and try again.`;
  }

  if (issue.code === "too_small") {
    if (issue.minimum === 1) {
      return `Please enter ${fieldLabel}.`;
    }
    return `Please check ${fieldLabel} and try again.`;
  }

  if (issue.code === "invalid_enum_value" || issue.code === "invalid_value") {
    return `Please choose a valid value for ${fieldLabel}.`;
  }

  if (issue.code === "invalid_format") {
    if (issue.format === "email") {
      return "Please enter a valid email address.";
    }
    if (issue.format === "url") {
      return "Please enter a valid URL that starts with http:// or https://.";
    }
    return `Please enter a valid value for ${fieldLabel}.`;
  }

  if (typeof issue.message === "string" && issue.message.trim()) {
    return issue.message;
  }

  return fallbackMessage;
}

const authInputSchema = z.object({
  name: z.string().trim().min(1, { message: "Please enter your full name." }),
  company: z.string().trim().optional().default(""),
  email: z
    .string()
    .trim()
    .min(1, { message: "Please enter your email address." })
    .refine((value) => EMAIL_PATTERN.test(value), { message: "Please enter a valid email address." }),
  password: z
    .string()
    .min(1, { message: "Please enter a password." })
    .min(8, { message: "Password must be at least 8 characters." }),
  role: z.string().trim().refine((value) => ROLE_OPTIONS.has(value), {
    message: "Please choose either owner or tenant.",
  }),
});

const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, { message: "Please enter your email address." })
    .refine((value) => EMAIL_PATTERN.test(value), { message: "Please enter a valid email address." }),
  password: z.string().min(1, { message: "Please enter your password." }),
  role: z
    .string()
    .trim()
    .optional()
    .refine((value) => !value || ROLE_OPTIONS.has(value), {
      message: "Please choose either owner or tenant.",
    }),
});

const propertySchema = z.object({
  title: z.string().trim().min(1, { message: "Please enter a property title." }),
  description: z.string().trim().min(1, { message: "Please add a property description." }),
  location: z.string().trim().min(1, { message: "Please enter the property location." }),
  city: z.string().trim().optional().default(""),
  state: z.string().trim().optional().default(""),
  size_sqft: z
    .coerce
    .number()
    .int({ message: "Please enter a whole number for size." })
    .min(100, { message: "Size must be at least 100 sq ft." })
    .max(100000, { message: "Size looks too large. Please check it and try again." }),
  monthly_price: z
    .coerce
    .number()
    .min(100, { message: "Monthly rent must be at least $100." })
    .max(1000000, { message: "Monthly rent looks too high. Please check it and try again." }),
  min_term_months: z
    .coerce
    .number()
    .int({ message: "Minimum term must be a whole number of months." })
    .min(1, { message: "Minimum term must be at least 1 month." })
    .max(24, { message: "Minimum term cannot be longer than 24 months." }),
  max_term_months: z
    .coerce
    .number()
    .int({ message: "Maximum term must be a whole number of months." })
    .min(1, { message: "Maximum term must be at least 1 month." })
    .max(24, { message: "Maximum term cannot be longer than 24 months." }),
  availability_text: z.string().trim().optional().default("Available now"),
  best_for: z.string().trim().optional().default(""),
  utilities: z.string().trim().optional().default(""),
  buildout: z.string().trim().optional().default(""),
  image_url: z
    .string()
    .trim()
    .optional()
    .default("")
    .refine((value) => !value || isValidHttpUrl(value), {
      message: "Please enter a valid photo URL, or leave it blank.",
    }),
  status: z
    .string()
    .trim()
    .optional()
    .default("active")
    .refine((value) => PROPERTY_STATUS_OPTIONS.has(value), {
      message: "Please choose a valid listing status.",
    }),
  amenities: z.array(z.string().trim().min(1, { message: "Please choose valid amenities." })).optional().default([]),
});

const reservationSchema = z.object({
  propertyId: z
    .coerce
    .number()
    .int({ message: "Please choose a property." })
    .min(1, { message: "Please choose a property." }),
  startDate: z.string().trim().regex(ISO_DATE_PATTERN, {
    message: "Please choose a valid start date.",
  }),
  endDate: z.string().trim().regex(ISO_DATE_PATTERN, {
    message: "Please choose a valid end date.",
  }),
});

const propertyStatusSchema = z.object({
  status: z.string().trim().refine((value) => PROPERTY_STATUS_OPTIONS.has(value), {
    message: "Please choose a valid listing status.",
  }),
});

const inquirySchema = z.object({
  name: z.string().trim().min(1, { message: "Please enter your name." }),
  email: z
    .string()
    .trim()
    .min(1, { message: "Please enter your email address." })
    .refine((value) => EMAIL_PATTERN.test(value), { message: "Please enter a valid email address." }),
  company: z.string().trim().optional().default(""),
  goal: z.string().trim().min(1, { message: "Please choose your primary goal." }),
  timeline: z.string().trim().min(1, { message: "Please choose your timeline." }),
  budget: z.string().trim().optional().default(""),
  message: z.string().trim().min(1, { message: "Please enter your message." }),
  property: z.string().trim().optional().default(""),
  location: z.string().trim().optional().default(""),
  source: z.string().trim().optional().default("website"),
  subject: z.string().trim().optional().default("New FillSpace inquiry"),
});

const connectAccountSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, { message: "Please enter an email address." })
    .refine((value) => EMAIL_PATTERN.test(value), { message: "Please enter a valid email address." }),
});

const accountIdSchema = z.object({
  accountId: z.string().trim().min(1, { message: "Missing account id." }),
});

const createProductSchema = z.object({
  productName: z.string().trim().min(1, { message: "Please enter a product name." }),
  productDescription: z.string().trim().optional().default(""),
  productPrice: z
    .coerce
    .number()
    .int({ message: "Price must be a whole number of cents." })
    .min(50, { message: "Price must be at least 50 cents." }),
  accountId: z.string().trim().min(1, { message: "Missing account id." }),
});

const checkoutSessionSchema = z.object({
  priceId: z.string().trim().min(1, { message: "Missing price id." }),
  accountId: z.string().trim().min(1, { message: "Missing account id." }),
});

app.use(cookieParser());

app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  runAsync(async (req, res) => {
    if (!stripe) {
      return res.status(501).json({ error: "Payment webhooks are unavailable right now." });
    }

    let event;
    if (STRIPE_WEBHOOK_SECRET) {
      const signature = req.headers["stripe-signature"];
      try {
        event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
      } catch (error) {
        return res.status(400).json({ error: "Webhook signature could not be verified." });
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
            security_deposit_status = CASE
              WHEN security_deposit_cents > 0 THEN 'held'
              ELSE security_deposit_status
            END,
            updated_at = CURRENT_TIMESTAMP
        WHERE stripe_checkout_session_id = ?
      `).run(session.payment_intent || "", session.id);
    }

    if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      db.prepare(`
        UPDATE reservations
        SET status = 'cancelled',
            security_deposit_status = 'none',
            updated_at = CURRENT_TIMESTAMP
        WHERE stripe_checkout_session_id = ?
      `).run(session.id);
    }

    if (event.type === "payment_intent.payment_failed") {
      const paymentIntent = event.data.object;
      db.prepare(`
        UPDATE reservations
        SET status = 'failed',
            security_deposit_status = 'none',
            updated_at = CURRENT_TIMESTAMP
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
    inquiryEmailConfigured: Boolean(inquiryMailer),
    timestamp: new Date().toISOString(),
  });
});

app.post(
  "/api/create-connect-account",
  runAsync(async (req, res) => {
    if (!stripe) {
      return res.status(501).json({ error: "Stripe is not configured on this server." });
    }
    const parsed = connectAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please provide a valid email address."),
      });
    }

    const account = await stripe.accounts.create({
      type: "express",
      country: "US",
      email: parsed.data.email,
      business_type: "company",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });

    return res.status(201).json({ accountId: account.id });
  })
);

app.post(
  "/api/create-account-link",
  runAsync(async (req, res) => {
    if (!stripe) {
      return res.status(501).json({ error: "Stripe is not configured on this server." });
    }
    const parsed = accountIdSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Missing connected account id."),
      });
    }

    const accountLink = await stripe.accountLinks.create({
      account: parsed.data.accountId,
      type: "account_onboarding",
      refresh_url: `${BASE_URL}/connect.html?accountId=${encodeURIComponent(parsed.data.accountId)}&onboarding=refresh`,
      return_url: `${BASE_URL}/connect.html?accountId=${encodeURIComponent(parsed.data.accountId)}&onboarding=return`,
    });

    return res.json({ url: accountLink.url });
  })
);

app.get(
  "/api/account-status/:accountId",
  runAsync(async (req, res) => {
    if (!stripe) {
      return res.status(501).json({ error: "Stripe is not configured on this server." });
    }

    const accountId = String(req.params.accountId || "").trim();
    if (!accountId) {
      return res.status(400).json({ error: "Missing connected account id." });
    }

    const account = await stripe.accounts.retrieve(accountId);
    return res.json({
      id: account.id,
      payoutsEnabled: Boolean(account.payouts_enabled),
      chargesEnabled: Boolean(account.charges_enabled),
      detailsSubmitted: Boolean(account.details_submitted),
      requirements: {
        currentlyDue: account?.requirements?.currently_due || [],
        pastDue: account?.requirements?.past_due || [],
        disabledReason: account?.requirements?.disabled_reason || "",
      },
    });
  })
);

app.get(
  "/api/account-login-link/:accountId",
  runAsync(async (req, res) => {
    if (!stripe) {
      return res.status(501).json({ error: "Stripe is not configured on this server." });
    }

    const accountId = String(req.params.accountId || "").trim();
    if (!accountId) {
      return res.status(400).json({ error: "Missing connected account id." });
    }

    const loginLink = await stripe.accounts.createLoginLink(accountId);
    return res.json({ url: loginLink.url });
  })
);

app.post(
  "/api/create-product",
  runAsync(async (req, res) => {
    if (!stripe) {
      return res.status(501).json({ error: "Stripe is not configured on this server." });
    }
    const parsed = createProductSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please review the product fields and try again."),
      });
    }

    const { productName, productDescription, productPrice, accountId } = parsed.data;
    const product = await stripe.products.create({
      name: productName,
      description: productDescription || "",
      metadata: { stripeAccount: accountId },
    });

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: productPrice,
      currency: "usd",
      metadata: { stripeAccount: accountId },
    });

    return res.status(201).json({
      id: product.id,
      productName: product.name,
      productDescription: product.description || "",
      productPrice,
      priceId: price.id,
    });
  })
);

app.get(
  "/api/products/:accountId",
  runAsync(async (req, res) => {
    if (!stripe) {
      return res.status(501).json({ error: "Stripe is not configured on this server." });
    }

    const accountId = String(req.params.accountId || "").trim();
    if (!accountId) {
      return res.status(400).json({ error: "Missing connected account id." });
    }

    const prices = await stripe.prices.search({
      query: `metadata['stripeAccount']:'${accountId}' AND active:'true'`,
      expand: ["data.product"],
      limit: 100,
    });

    return res.json(
      prices.data.map((price) => ({
        id: price.product.id,
        name: price.product.name,
        description: price.product.description,
        price: price.unit_amount,
        priceId: price.id,
        period: price.recurring ? price.recurring.interval : null,
        image: "https://i.imgur.com/6Mvijcm.png",
      }))
    );
  })
);

app.post(
  "/api/create-checkout-session",
  runAsync(async (req, res) => {
    if (!stripe) {
      return res.status(501).json({ error: "Stripe is not configured on this server." });
    }

    const parsed = checkoutSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Missing checkout details."),
      });
    }
    const { priceId, accountId } = parsed.data;
    const connectedStatus = await getStripeStatusForAccountId(accountId);
    if (!connectedStatus.ready) {
      return res.status(409).json({
        error: "This connected account is not ready to accept payments yet.",
      });
    }

    const price = await stripe.prices.retrieve(priceId);
    const mode = price.type === "recurring" ? "subscription" : "payment";
    const priceAmount = Number(price.unit_amount || 0);
    const feeAmount = feeAmountFromSubtotal(priceAmount);

    const sessionConfig = {
      line_items: [{ price: priceId, quantity: 1 }],
      mode,
      success_url: `${BASE_URL}/done.html?session_id={CHECKOUT_SESSION_ID}&accountId=${encodeURIComponent(accountId)}`,
      cancel_url: `${BASE_URL}/connect.html?accountId=${encodeURIComponent(accountId)}&checkout=cancelled`,
    };

    if (mode === "subscription") {
      sessionConfig.subscription_data = {
        application_fee_percent: Number((PLATFORM_FEE_RATE * 100).toFixed(2)),
        transfer_data: { destination: accountId },
      };
    } else {
      sessionConfig.payment_intent_data = {
        application_fee_amount: feeAmount,
        transfer_data: { destination: accountId },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    return res.redirect(303, session.url);
  })
);

app.post(
  "/api/auth/register",
  runAsync(async (req, res) => {
    const parsed = authInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please check your registration details and try again."),
      });
    }

    const data = parsed.data;
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(data.email);
    if (existing) {
      return res.status(409).json({ error: "That email is already in use. Try signing in instead." });
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
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please enter your email and password to sign in."),
      });
    }

    const data = parsed.data;
    const userRow = db.prepare("SELECT * FROM users WHERE email = ?").get(data.email);
    if (!userRow) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }

    if (data.role && userRow.role !== data.role) {
      return res.status(403).json({ error: `Please use the ${userRow.role} login for this account.` });
    }

    const passwordOk = await bcrypt.compare(data.password, userRow.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ error: "Email or password is incorrect." });
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
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please review your message and try again."),
      });
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
    let delivered = false;
    let deliveryStatus = "stored-only";

    if (inquiryMailer) {
      try {
        await sendInquiryEmailDirect(data);
        delivered = true;
        deliveryStatus = "smtp-sent";
      } catch (error) {
        console.error("Direct inquiry email failed:", error?.message || error);
        deliveryStatus = "smtp-failed";
      }
    }

    if (!delivered && INQUIRY_FORWARD_ENABLED && INQUIRY_FORWARD_URL) {
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
          delivered = true;
          deliveryStatus = "forwarded";
        } else {
          deliveryStatus = `forward-http-${forwardRes.status}`;
        }
      } catch {
        deliveryStatus = "forward-failed";
      }
    }

    db.prepare(`
      UPDATE inquiries
      SET email_forwarded = ?, forward_status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(delivered ? 1 : 0, deliveryStatus, inquiryId);

    const responseMessage = delivered
      ? "Complete. Your request has been sent."
      : "Complete. Your request was saved and is queued for follow-up.";
    return res.status(delivered ? 201 : 202).json({
      ok: true,
      inquiry_id: inquiryId,
      status: delivered ? "complete" : "stored",
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
      return res.status(404).json({ error: "We couldn't find that property." });
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
    const stripeStatus = await getStripeStatusForUser(req.user);
    if (!stripeStatus.ready) {
      return res.status(409).json({
        error: stripeSetupMessage(stripeStatus),
        stripe_status: stripeStatus,
      });
    }

    const parsed = propertySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please review the property details and try again."),
      });
    }
    const data = parsed.data;

    if (data.status === "active") {
      const stripeStatus = await getStripeStatusForUser(req.user);
      if (!stripeStatus.ready) {
        return res.status(409).json({
          error: stripeSetupMessage(stripeStatus),
          stripe_status: stripeStatus,
        });
      }
    }

    if (data.max_term_months < data.min_term_months) {
      return res.status(400).json({
        error: "Maximum term must be the same as or longer than the minimum term.",
      });
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
    const normalizedProperty = normalizePropertyRow(property);

    if (normalizedProperty) {
      sendOwnerListingNotification(req.user, normalizedProperty).catch((error) => {
        console.error("Owner listing notify email failed:", error?.message || error);
      });
    }

    return res.status(201).json({ property: normalizedProperty });
  })
);

app.put(
  "/api/owner/properties/:id",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const propertyId = Number(req.params.id);
    if (!Number.isFinite(propertyId)) {
      return res.status(400).json({ error: "We couldn't identify that listing. Please refresh and try again." });
    }

    const existing = db.prepare("SELECT * FROM properties WHERE id = ? AND owner_id = ?").get(propertyId, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: "We couldn't find that listing in your account." });
    }

    const parsed = propertySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please review the property details and try again."),
      });
    }
    const data = parsed.data;

    if (data.max_term_months < data.min_term_months) {
      return res.status(400).json({
        error: "Maximum term must be the same as or longer than the minimum term.",
      });
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
      return res.status(400).json({ error: "We couldn't identify that listing. Please refresh and try again." });
    }

    const parsed = propertyStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please choose a valid listing status."),
      });
    }

    if (parsed.data.status === "active") {
      const stripeStatus = await getStripeStatusForUser(req.user);
      if (!stripeStatus.ready) {
        return res.status(409).json({
          error: stripeSetupMessage(stripeStatus),
          stripe_status: stripeStatus,
        });
      }
    }

    const existing = db.prepare("SELECT * FROM properties WHERE id = ? AND owner_id = ?").get(propertyId, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: "We couldn't find that listing in your account." });
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
      return res.status(400).json({ error: "We couldn't identify that listing. Please refresh and try again." });
    }

    const existing = db.prepare("SELECT * FROM properties WHERE id = ? AND owner_id = ?").get(propertyId, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: "We couldn't find that listing in your account." });
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
        r.security_deposit_cents,
        r.security_deposit_status,
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
        security_deposit: usdFromCents(row.security_deposit_cents || 0),
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
      {
        id: "tax-1099-export",
        name: "1099 Export (CSV)",
        category: "Tax",
        updated_at: new Date().toISOString().slice(0, 10),
      },
    ],
  });
});

app.get(
  "/api/owner/tax/1099-summary",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const requestedYear = Number(req.query.year || new Date().getFullYear());
    if (!Number.isInteger(requestedYear) || requestedYear < 2000 || requestedYear > 2100) {
      return res.status(400).json({ error: "Please provide a valid tax year." });
    }
    const yearText = String(requestedYear);
    const summary = db.prepare(`
      SELECT
        COUNT(*) AS reservation_count,
        COALESCE(SUM(total_cents), 0) AS gross_cents,
        COALESCE(SUM(platform_fee_cents), 0) AS platform_fee_cents,
        COALESCE(SUM(owner_payout_cents), 0) AS owner_payout_cents
      FROM reservations
      WHERE owner_id = ?
        AND status = 'confirmed'
        AND substr(created_at, 1, 4) = ?
    `).get(req.user.id, yearText);

    return res.json({
      year: requestedYear,
      reservation_count: Number(summary?.reservation_count || 0),
      gross_total: usdFromCents(summary?.gross_cents || 0),
      platform_fees: usdFromCents(summary?.platform_fee_cents || 0),
      owner_payout_total: usdFromCents(summary?.owner_payout_cents || 0),
    });
  })
);

app.get(
  "/api/owner/tax/1099.csv",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const requestedYear = Number(req.query.year || new Date().getFullYear());
    if (!Number.isInteger(requestedYear) || requestedYear < 2000 || requestedYear > 2100) {
      return res.status(400).json({ error: "Please provide a valid tax year." });
    }
    const yearText = String(requestedYear);
    const rows = db.prepare(`
      SELECT
        r.id,
        r.created_at,
        r.total_cents,
        r.platform_fee_cents,
        r.owner_payout_cents,
        r.security_deposit_cents,
        r.security_deposit_status,
        p.title AS property_title,
        u.name AS tenant_name,
        u.email AS tenant_email
      FROM reservations r
      JOIN properties p ON p.id = r.property_id
      JOIN users u ON u.id = r.tenant_id
      WHERE r.owner_id = ?
        AND r.status = 'confirmed'
        AND substr(r.created_at, 1, 4) = ?
      ORDER BY r.created_at ASC
    `).all(req.user.id, yearText);

    const header = [
      "reservation_id",
      "created_at",
      "property_title",
      "tenant_name",
      "tenant_email",
      "gross_usd",
      "platform_fee_usd",
      "owner_payout_usd",
      "security_deposit_usd",
      "security_deposit_status",
    ];
    const lines = [header.join(",")];
    for (const row of rows) {
      lines.push(
        [
          csvEscape(row.id),
          csvEscape(row.created_at),
          csvEscape(row.property_title),
          csvEscape(row.tenant_name),
          csvEscape(row.tenant_email),
          csvEscape(usdFromCents(row.total_cents)),
          csvEscape(usdFromCents(row.platform_fee_cents)),
          csvEscape(usdFromCents(row.owner_payout_cents)),
          csvEscape(usdFromCents(row.security_deposit_cents || 0)),
          csvEscape(row.security_deposit_status || "none"),
        ].join(",")
      );
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"fillspace-1099-${requestedYear}.csv\"`);
    res.status(200).send(lines.join("\n"));
  })
);

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
        error: "Payout setup is temporarily unavailable. Please try again later.",
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

    const stripeStatus = await getStripeStatusForAccountId(accountId);
    if (stripeStatus.ready) {
      return res.json({
        stripe_account_id: accountId,
        stripe_status: stripeStatus,
        onboarding_url: "",
      });
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${BASE_URL}/dashboard-owner.html?stripe=refresh`,
      return_url: `${BASE_URL}/dashboard-owner.html?stripe=connected`,
      type: "account_onboarding",
    });

    return res.json({
      stripe_account_id: accountId,
      stripe_status: stripeStatus,
      onboarding_url: accountLink.url,
    });
  })
);

app.get(
  "/api/owner/stripe/status",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const stripeStatus = await getStripeStatusForUser(req.user);
    return res.json({
      stripe_status: stripeStatus,
      message: stripeSetupMessage(stripeStatus),
    });
  })
);

app.get(
  "/api/owner/dashboard",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const stripeStatus = await getStripeStatusForUser(req.user);
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
        r.security_deposit_cents,
        r.security_deposit_status,
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
      stripe_connected: Boolean(stripeStatus.ready),
      stripe_status: stripeStatus,
      stripe_message: stripeSetupMessage(stripeStatus),
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
        security_deposit: usdFromCents(row.security_deposit_cents || 0),
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
      return res.status(400).json({ error: "We couldn't identify that property. Please refresh and try again." });
    }
    const property = db.prepare("SELECT id FROM properties WHERE id = ? AND status = 'active'").get(propertyId);
    if (!property) {
      return res.status(404).json({ error: "We couldn't find that property." });
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
      return res.status(400).json({ error: "We couldn't identify that property. Please refresh and try again." });
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
        security_deposit: usdFromCents(row.security_deposit_cents || 0),
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
        r.security_deposit_cents,
        r.security_deposit_status,
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
        security_deposit: usdFromCents(row.security_deposit_cents || 0),
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
        error: "Online checkout is temporarily unavailable. Please try again later.",
      });
    }

    const parsed = reservationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please review your booking details and try again."),
      });
    }
    const data = parsed.data;

    const property = db.prepare("SELECT * FROM properties WHERE id = ? AND status = 'active'").get(data.propertyId);
    if (!property) {
      return res.status(404).json({ error: "We couldn't find that property." });
    }
    if (property.owner_id === req.user.id) {
      return res.status(400).json({ error: "You can't book your own listing." });
    }

    const owner = db.prepare("SELECT id, email, stripe_account_id FROM users WHERE id = ?").get(property.owner_id);
    if (!owner?.stripe_account_id) {
      return res.status(409).json({
        error: "This listing is not ready for checkout yet. Please try another listing.",
      });
    }
    const ownerStripeStatus = await getStripeStatusForAccountId(owner.stripe_account_id);
    if (!ownerStripeStatus.ready) {
      return res.status(409).json({
        error: "This owner is still finishing payout onboarding. Please try another listing for now.",
      });
    }

    const durationMonths = calculateDurationInMonths(data.startDate, data.endDate);
    if (!durationMonths) {
      return res.status(400).json({ error: "Please choose an end date that is after the start date." });
    }
    if (durationMonths < property.min_term_months || durationMonths > property.max_term_months) {
      return res.status(400).json({
        error: `Please choose dates that create a term between ${property.min_term_months} and ${property.max_term_months} months.`,
      });
    }

    const totalCents = property.monthly_price_cents * durationMonths;
    const securityDepositCents = SECURITY_DEPOSIT_CENTS;
    const chargeSubtotalCents = totalCents;
    const platformFeeCents = feeAmountFromSubtotal(chargeSubtotalCents);
    const ownerPayoutCents = chargeSubtotalCents - platformFeeCents;
    const totalChargedNowCents = chargeSubtotalCents + securityDepositCents;
    const applicationFeeAmount = platformFeeCents + securityDepositCents;

    const reservationInsert = db.prepare(`
      INSERT INTO reservations (
        property_id, tenant_id, owner_id, start_date, end_date, status,
        total_cents, platform_fee_cents, owner_payout_cents,
        security_deposit_cents, security_deposit_status
      )
      VALUES (?, ?, ?, ?, ?, 'payment_pending', ?, ?, ?, ?, ?)
    `);
    const insertResult = reservationInsert.run(
      property.id,
      req.user.id,
      property.owner_id,
      data.startDate,
      data.endDate,
      totalCents,
      platformFeeCents,
      ownerPayoutCents,
      securityDepositCents,
      securityDepositCents > 0 ? "pending" : "none"
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
        ...(securityDepositCents > 0
          ? [
              {
                quantity: 1,
                price_data: {
                  currency: "usd",
                  unit_amount: securityDepositCents,
                  product_data: {
                    name: "Security deposit (refundable)",
                    description: "Held by FillSpace and released after move-out review.",
                  },
                },
              },
            ]
          : []),
      ],
      payment_intent_data: {
        application_fee_amount: applicationFeeAmount,
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
      security_deposit: currency(securityDepositCents),
      charged_now: currency(totalChargedNowCents),
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
      return res.status(400).json({ error: "Please choose a property, start date, and end date." });
    }

    const property = db.prepare("SELECT * FROM properties WHERE id = ?").get(propertyId);
    if (!property) {
      return res.status(404).json({ error: "We couldn't find that property." });
    }

    const months = calculateDurationInMonths(startDate, endDate);
    if (!months) {
      return res.status(400).json({ error: "Please choose an end date that is after the start date." });
    }
    const totalCents = property.monthly_price_cents * months;
    const securityDepositCents = SECURITY_DEPOSIT_CENTS;
    const platformFeeCents = feeAmountFromSubtotal(totalCents);
    const ownerPayoutCents = totalCents - platformFeeCents;

    return res.json({
      months,
      total: usdFromCents(totalCents),
      security_deposit: usdFromCents(securityDepositCents),
      charged_now: usdFromCents(totalCents + securityDepositCents),
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
  res.status(500).json({ error: "Something went wrong on our side. Please try again." });
});

app.listen(PORT, () => {
  console.log(`FillSpace server running at ${BASE_URL}`);
  console.log(`Stripe configured: ${stripe ? "yes" : "no"}`);
  console.log(`Inquiry SMTP configured: ${inquiryMailer ? "yes" : "no"}`);
  console.log(`Listing notify target: ${LISTING_NOTIFY_EMAIL_TO}`);
});

