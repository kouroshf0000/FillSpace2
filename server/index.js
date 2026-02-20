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
const DEFAULT_TAX_RATE_BPS = Number(process.env.DEFAULT_TAX_RATE_BPS || 625);
const BOOKING_RESPONSE_HOURS = 48;
const PAYMENT_LINK_HOURS = 48;
const DOCUMENTS_DEADLINE_HOURS = 24;
const DECLINE_COOLDOWN_DAYS = 7;
const STRIKE_FREEZE_DAYS = 14;
const AUTOMATION_POLL_MS = 60 * 1000;
const PLATFORM_TIMEZONE = "America/New_York";
const SYSTEM_SENDER_NAME = "FillSpace Team";
const CANCELLATION_POLICY_OPTIONS = new Set(["flexible", "moderate", "strict"]);
const ADMIN_DEMO_EMAIL = process.env.ADMIN_DEMO_EMAIL || "admin@fillspace.com";
const ADMIN_DEMO_PASSWORD = process.env.ADMIN_DEMO_PASSWORD || "Admin123!";
const ADMIN_DEMO_NAME = process.env.ADMIN_DEMO_NAME || "FillSpace Admin";
const PAYMENT_REMINDER_OFFSETS_HOURS = [36, 24, 12, 2];
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
    if (payload?.role === "admin" && payload?.sub === "admin-demo") {
      return {
        id: "admin-demo",
        role: "admin",
        name: ADMIN_DEMO_NAME,
        company: "FillSpace",
        email: ADMIN_DEMO_EMAIL,
        stripe_account_id: "",
        strike_count: 0,
        frozen_until: "",
        created_at: new Date(0).toISOString(),
      };
    }
    const row = db
      .prepare(
        "SELECT id, role, name, company, email, stripe_account_id, strike_count, frozen_until, created_at FROM users WHERE id = ?"
      )
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
  if (req.user.role !== "admin" && isUserFrozen(req.user)) {
    return res.status(423).json({ error: freezeMessage(req.user.frozen_until) });
  }
  return next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Please sign in to continue." });
    }
    if (req.user.role !== "admin" && isUserFrozen(req.user)) {
      return res.status(423).json({ error: freezeMessage(req.user.frozen_until) });
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

function nowIso() {
  return new Date().toISOString();
}

function addHoursIso(isoString, hours) {
  const base = isoString ? new Date(isoString) : new Date();
  return new Date(base.getTime() + Math.round(hours * 60 * 60 * 1000)).toISOString();
}

function addDaysIso(isoString, days) {
  return addHoursIso(isoString, days * 24);
}

function isUserFrozen(user) {
  const frozenUntil = String(user?.frozen_until || "").trim();
  if (!frozenUntil) {
    return false;
  }
  const ts = Date.parse(frozenUntil);
  if (!Number.isFinite(ts)) {
    return false;
  }
  return ts > Date.now();
}

function freezeMessage(frozenUntil) {
  const dateText = String(frozenUntil || "").slice(0, 16).replace("T", " ");
  if (!dateText) {
    return "Your account is temporarily frozen. Please contact FillSpace support.";
  }
  return `Your account is temporarily frozen until ${dateText} (${PLATFORM_TIMEZONE}).`;
}

function hoursUntil(targetIso) {
  const ts = Date.parse(String(targetIso || ""));
  if (!Number.isFinite(ts)) {
    return null;
  }
  return (ts - Date.now()) / (1000 * 60 * 60);
}

function stableJson(input) {
  try {
    return JSON.stringify(input || {});
  } catch {
    return "{}";
  }
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

async function sendPlatformEmail({ to, subject, lines, replyTo = "" }) {
  if (!inquiryMailer || !to) {
    return false;
  }
  const fromAddress = INQUIRY_EMAIL_FROM.includes("<")
    ? INQUIRY_EMAIL_FROM
    : `${SYSTEM_SENDER_NAME} <${INQUIRY_EMAIL_FROM}>`;
  await inquiryMailer.sendMail({
    from: fromAddress,
    to,
    subject,
    text: Array.isArray(lines) ? lines.join("\n") : String(lines || ""),
    ...(replyTo ? { replyTo } : {}),
  });
  return true;
}

function insertNotification({
  userId,
  reservationId = null,
  type = "",
  message = "",
  channel = "in_app",
  emailTo = "",
  emailSent = false,
}) {
  if (!Number.isFinite(Number(userId))) {
    return;
  }
  db.prepare(`
    INSERT INTO notifications (
      user_id, reservation_id, type, message, channel, email_to, email_sent
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(userId),
    reservationId ? Number(reservationId) : null,
    String(type || ""),
    String(message || ""),
    String(channel || "in_app"),
    String(emailTo || ""),
    emailSent ? 1 : 0
  );
}

function logReservationAudit({
  reservationId,
  actorUserId = null,
  actorRole = "",
  eventType = "",
  fromStatus = "",
  toStatus = "",
  details = {},
}) {
  if (!Number.isFinite(Number(reservationId))) {
    return;
  }
  db.prepare(`
    INSERT INTO reservation_audit_logs (
      reservation_id, actor_user_id, actor_role, event_type, from_status, to_status, details_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(reservationId),
    actorUserId ? Number(actorUserId) : null,
    String(actorRole || ""),
    String(eventType || ""),
    String(fromStatus || ""),
    String(toStatus || ""),
    stableJson(details)
  );
}

function getReservationById(reservationId) {
  return db.prepare("SELECT * FROM reservations WHERE id = ?").get(reservationId);
}

function reservationHasAcceptedOverlap(propertyId, startDate, endDate, ignoreReservationId = 0) {
  const row = db.prepare(`
    SELECT id
    FROM reservations
    WHERE property_id = ?
      AND id != ?
      AND status IN ('payment_pending', 'payment_completed', 'documents_pending', 'documents_incomplete', 'booking_confirmed')
      AND NOT (end_date <= ? OR start_date >= ?)
    LIMIT 1
  `).get(propertyId, Number(ignoreReservationId || 0), startDate, endDate);
  return Boolean(row?.id);
}

function randomToken(bytes = 20) {
  return crypto.randomBytes(bytes).toString("hex");
}

function userRowById(userId) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}

function userDisplayName(user) {
  return String(user?.name || user?.email || "FillSpace user");
}

function bookingStatusLabel(status) {
  return String(status || "").replaceAll("_", " ");
}

function reservationPaymentLink(token) {
  return `${BASE_URL}/api/payments/checkout-link/${encodeURIComponent(token)}`;
}

function markReservationStatus({
  reservationId,
  nextStatus,
  actorUserId = null,
  actorRole = "",
  eventType = "",
  details = {},
}) {
  const previous = getReservationById(reservationId);
  if (!previous) {
    return null;
  }
  db.prepare(`
    UPDATE reservations
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nextStatus, reservationId);
  logReservationAudit({
    reservationId,
    actorUserId,
    actorRole,
    eventType: eventType || "status_changed",
    fromStatus: previous.status,
    toStatus: nextStatus,
    details,
  });
  return getReservationById(reservationId);
}

function incrementStrike(userId, reason, reservationId = null) {
  const user = userRowById(userId);
  if (!user) {
    return { strike_count: 0, frozen_until: "" };
  }
  const nextStrikeCount = Number(user.strike_count || 0) + 1;
  let frozenUntil = String(user.frozen_until || "");
  let storedStrikeCount = nextStrikeCount;

  if (nextStrikeCount >= 3) {
    frozenUntil = addDaysIso(nowIso(), STRIKE_FREEZE_DAYS);
    storedStrikeCount = 0;
  }

  db.prepare(`
    UPDATE users
    SET strike_count = ?, frozen_until = ?
    WHERE id = ?
  `).run(storedStrikeCount, frozenUntil, userId);

  insertNotification({
    userId,
    reservationId,
    type: "account_strike",
    message:
      nextStrikeCount >= 3
        ? `A strike was added and your account is frozen until ${String(frozenUntil).slice(0, 16).replace("T", " ")}.`
        : `A strike was added to your account. Current strike count: ${nextStrikeCount}.`,
    channel: "in_app",
  });

  if (reservationId) {
    logReservationAudit({
      reservationId,
      actorUserId: userId,
      actorRole: user.role,
      eventType: "user_strike_applied",
      details: {
        reason,
        strike_count: nextStrikeCount,
        frozen_until: frozenUntil,
      },
    });
  }

  return { strike_count: nextStrikeCount, frozen_until: frozenUntil };
}

async function notifyReservationUsers({
  reservation,
  owner,
  tenant,
  type,
  tenantMessage,
  ownerMessage,
  tenantEmailSubject = "",
  ownerEmailSubject = "",
}) {
  if (tenant?.id && tenantMessage) {
    let sent = false;
    if (tenant.email && tenantEmailSubject) {
      try {
        await sendPlatformEmail({
          to: tenant.email,
          subject: tenantEmailSubject,
          lines: [tenantMessage],
        });
        sent = true;
      } catch (error) {
        console.error("Tenant notification email failed:", error?.message || error);
      }
    }
    insertNotification({
      userId: tenant.id,
      reservationId: reservation?.id,
      type,
      message: tenantMessage,
      channel: "in_app",
      emailTo: tenant.email || "",
      emailSent: sent,
    });
  }

  if (owner?.id && ownerMessage) {
    let sent = false;
    if (owner.email && ownerEmailSubject) {
      try {
        await sendPlatformEmail({
          to: owner.email,
          subject: ownerEmailSubject,
          lines: [ownerMessage],
        });
        sent = true;
      } catch (error) {
        console.error("Owner notification email failed:", error?.message || error);
      }
    }
    insertNotification({
      userId: owner.id,
      reservationId: reservation?.id,
      type,
      message: ownerMessage,
      channel: "in_app",
      emailTo: owner.email || "",
      emailSent: sent,
    });
  }
}

async function activatePaymentWindow({
  reservationId,
  owner,
  tenant,
  initiatedBy = "owner_accept",
  actorUserId = null,
  actorRole = "system",
}) {
  const reservation = getReservationById(reservationId);
  if (!reservation) {
    return null;
  }
  const token = randomToken(24);
  const now = nowIso();
  const paymentDeadline = addHoursIso(now, PAYMENT_LINK_HOURS);
  const autoAccepted = initiatedBy === "auto_accept" ? 1 : 0;
  db.prepare(`
    UPDATE reservations
    SET
      status = 'payment_pending',
      owner_response_at = ?,
      owner_response_type = ?,
      auto_accepted = ?,
      payment_deadline_at = ?,
      payment_link_token = ?,
      checkout_link_sent_at = ?,
      reminder_36_sent_at = '',
      reminder_24_sent_at = '',
      reminder_12_sent_at = '',
      reminder_2_sent_at = '',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(now, initiatedBy, autoAccepted, paymentDeadline, token, now, reservationId);

  logReservationAudit({
    reservationId,
    actorUserId,
    actorRole,
    eventType: initiatedBy === "auto_accept" ? "request_auto_accepted" : "request_accepted",
    fromStatus: reservation.status,
    toStatus: "payment_pending",
    details: {
      payment_deadline_at: paymentDeadline,
      payment_link_token: token,
    },
  });

  const paymentUrl = reservationPaymentLink(token);
  const tenantMessage = initiatedBy === "auto_accept"
    ? `Your booking request for ${reservation.start_date} to ${reservation.end_date} was auto-accepted after 48 hours. Complete payment by ${paymentDeadline.slice(0, 16).replace("T", " ")} (${PLATFORM_TIMEZONE}): ${paymentUrl}`
    : `Your booking request for ${reservation.start_date} to ${reservation.end_date} was accepted. Complete payment by ${paymentDeadline.slice(0, 16).replace("T", " ")} (${PLATFORM_TIMEZONE}): ${paymentUrl}`;
  const ownerMessage = initiatedBy === "auto_accept"
    ? `A booking request for your listing was auto-accepted because it was not answered within 48 hours.`
    : `You accepted a booking request. The tenant now has 48 hours to complete payment.`;

  await notifyReservationUsers({
    reservation: { ...reservation, id: reservationId },
    owner,
    tenant,
    type: initiatedBy === "auto_accept" ? "request_auto_accepted" : "request_accepted",
    tenantMessage,
    ownerMessage,
    tenantEmailSubject: "FillSpace booking accepted: payment link",
    ownerEmailSubject: "FillSpace booking request accepted",
  });

  return getReservationById(reservationId);
}

async function systemDeclineReservation(reservation, reason, tenantMessage, ownerMessage) {
  if (!reservation?.id) {
    return null;
  }
  const now = nowIso();
  db.prepare(`
    UPDATE reservations
    SET
      status = 'request_declined',
      owner_response_at = ?,
      owner_response_type = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(now, reason, reservation.id);
  logReservationAudit({
    reservationId: reservation.id,
    actorRole: "system",
    eventType: "request_auto_declined",
    fromStatus: reservation.status,
    toStatus: "request_declined",
    details: { reason },
  });
  const updated = getReservationById(reservation.id);
  const owner = userRowById(reservation.owner_id);
  const tenant = userRowById(reservation.tenant_id);
  await notifyReservationUsers({
    reservation: updated,
    owner,
    tenant,
    type: "request_auto_declined",
    tenantMessage,
    ownerMessage,
    tenantEmailSubject: "Booking request update",
  });
  return updated;
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

function taxCentsFromSubtotal(subtotalCents, taxRateBps) {
  const cents = Number(subtotalCents || 0);
  const bps = Number(taxRateBps || DEFAULT_TAX_RATE_BPS);
  if (!Number.isFinite(cents) || cents <= 0 || !Number.isFinite(bps) || bps <= 0) {
    return 0;
  }
  return Math.max(0, Math.round((cents * bps) / 10000));
}

function firstMonthChargePlan(property, monthsReserved) {
  const subtotalCents = Number(property?.monthly_price_cents || 0);
  const taxRateBps = Number(property?.tax_rate_bps || DEFAULT_TAX_RATE_BPS);
  const taxCents = taxCentsFromSubtotal(subtotalCents, taxRateBps);
  const totalCents = subtotalCents + taxCents;
  const platformFeeCents = feeAmountFromSubtotal(subtotalCents);
  const ownerPayoutCents = Math.max(0, subtotalCents - platformFeeCents);
  return {
    months_reserved: Number(monthsReserved || 0),
    subtotal_cents: subtotalCents,
    tax_cents: taxCents,
    total_cents: totalCents,
    platform_fee_cents: platformFeeCents,
    owner_payout_cents: ownerPayoutCents,
  };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ROLE_OPTIONS = new Set(["owner", "tenant"]);
const LOGIN_ROLE_OPTIONS = new Set(["owner", "tenant", "admin"]);
const PROPERTY_STATUS_OPTIONS = new Set(["active", "draft", "paused"]);
const BOOKING_REQUEST_DECISIONS = new Set(["accept", "decline"]);
const RESERVATION_STATUS_OPTIONS = new Set([
  "request_submitted",
  "request_declined",
  "payment_pending",
  "payment_completed",
  "documents_pending",
  "documents_under_review",
  "documents_incomplete",
  "documents_rejected",
  "booking_confirmed",
  "booking_cancelled",
  "confirmed",
  "failed",
  "cancelled",
  "pending",
  "payment_pending",
]);
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
  cancellation_policy: "a cancellation policy",
  decision: "a decision",
  document_type: "a document type",
  file_url: "a file URL",
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
    .refine((value) => !value || LOGIN_ROLE_OPTIONS.has(value), {
      message: "Please choose a valid account type.",
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
  cancellation_policy: z
    .string()
    .trim()
    .optional()
    .default("moderate")
    .refine((value) => CANCELLATION_POLICY_OPTIONS.has(value), {
      message: "Please choose a valid cancellation policy.",
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

const bookingRequestCreateSchema = z.object({
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

const bookingRequestUpdateSchema = z.object({
  startDate: z.string().trim().regex(ISO_DATE_PATTERN, {
    message: "Please choose a valid start date.",
  }),
  endDate: z.string().trim().regex(ISO_DATE_PATTERN, {
    message: "Please choose a valid end date.",
  }),
});

const ownerBookingDecisionSchema = z.object({
  decision: z.string().trim().refine((value) => BOOKING_REQUEST_DECISIONS.has(value), {
    message: "Please choose either accept or decline.",
  }),
});

const propertyRequestPauseSchema = z.object({
  paused: z.coerce.boolean(),
});

const propertyRequestSettingsSchema = z
  .object({
    paused: z.coerce.boolean().optional(),
    cancellation_policy: z
      .string()
      .trim()
      .optional()
      .refine((value) => !value || CANCELLATION_POLICY_OPTIONS.has(value), {
        message: "Please choose a valid cancellation policy.",
      }),
  })
  .refine((value) => value.paused !== undefined || value.cancellation_policy, {
    message: "Please update at least one request setting.",
  });

const reservationDocumentSchema = z.object({
  party: z
    .string()
    .trim()
    .refine((value) => value === "tenant" || value === "owner", {
      message: "Please choose who is submitting this document.",
    }),
  document_type: z.string().trim().min(1, { message: "Please choose a document type." }),
  file_name: z.string().trim().min(1, { message: "Please provide a file name." }),
  file_url: z
    .string()
    .trim()
    .min(1, { message: "Please provide a file URL." })
    .refine((value) => isValidHttpUrl(value), {
      message: "Please provide a valid URL for the uploaded file.",
    }),
  mime_type: z.string().trim().optional().default(""),
  size_bytes: z
    .coerce
    .number()
    .int({ message: "Please provide a valid file size." })
    .min(0, { message: "Please provide a valid file size." })
    .max(200 * 1024 * 1024, { message: "File size must be under 200MB." })
    .default(0),
  accepted_terms: z.coerce.boolean().refine((value) => value === true, {
    message: "Please accept the document submission terms to continue.",
  }),
});

const adminReviewSchema = z.object({
  approved: z.coerce.boolean(),
  notes: z.string().trim().optional().default(""),
});

const adminStatusOverrideSchema = z.object({
  status: z.string().trim().refine((value) => RESERVATION_STATUS_OPTIONS.has(value), {
    message: "Please choose a valid reservation status.",
  }),
  notes: z.string().trim().optional().default(""),
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
      const reservation = db.prepare("SELECT * FROM reservations WHERE stripe_checkout_session_id = ?").get(session.id);
      if (reservation) {
        const paidAt = nowIso();
        const docsDueAt = addHoursIso(paidAt, DOCUMENTS_DEADLINE_HOURS);
        const payoutAvailableAt = addDaysIso(`${reservation.start_date}T00:00:00.000Z`, 3);
        db.prepare(`
          UPDATE reservations
          SET
            status = 'documents_pending',
            stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
            payment_completed_at = ?,
            documents_due_at = ?,
            documents_status = 'pending',
            payout_available_at = ?,
            security_deposit_status = 'none',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(session.payment_intent || "", paidAt, docsDueAt, payoutAvailableAt, reservation.id);
        logReservationAudit({
          reservationId: reservation.id,
          actorRole: "system",
          eventType: "payment_completed",
          fromStatus: reservation.status,
          toStatus: "documents_pending",
          details: { stripe_session_id: session.id },
        });
        const owner = userRowById(reservation.owner_id);
        const tenant = userRowById(reservation.tenant_id);
        await notifyReservationUsers({
          reservation: getReservationById(reservation.id),
          owner,
          tenant,
          type: "payment_completed",
          tenantMessage: "Payment successful. Please complete required documents within 24 hours.",
          ownerMessage: "Tenant payment completed. Both parties now need to submit required documents.",
          tenantEmailSubject: "Payment received - documents required",
          ownerEmailSubject: "Tenant payment received",
        });
      }
    }

    if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      const reservation = db.prepare("SELECT * FROM reservations WHERE stripe_checkout_session_id = ?").get(session.id);
      if (reservation && reservation.status === "payment_pending") {
        markReservationStatus({
          reservationId: reservation.id,
          nextStatus: "booking_cancelled",
          actorRole: "system",
          eventType: "checkout_session_expired",
        });
      }
    }

    if (event.type === "payment_intent.payment_failed") {
      const paymentIntent = event.data.object;
      const metadataReservationId = Number(paymentIntent?.metadata?.reservationId || 0);
      const reservation =
        db.prepare("SELECT * FROM reservations WHERE stripe_payment_intent_id = ?").get(paymentIntent.id) ||
        (Number.isFinite(metadataReservationId) && metadataReservationId > 0
          ? db.prepare("SELECT * FROM reservations WHERE id = ?").get(metadataReservationId)
          : null);
      if (reservation) {
        logReservationAudit({
          reservationId: reservation.id,
          actorRole: "system",
          eventType: "payment_failed",
          fromStatus: reservation.status,
          toStatus: reservation.status,
          details: { payment_intent_id: paymentIntent.id },
        });
        const owner = userRowById(reservation.owner_id);
        const tenant = userRowById(reservation.tenant_id);
        await notifyReservationUsers({
          reservation,
          owner,
          tenant,
          type: "payment_failed",
          tenantMessage: "Payment failed. Please use your payment link to try again before it expires.",
          ownerMessage: "A tenant payment attempt failed. The request remains open until the payment deadline.",
          tenantEmailSubject: "Payment attempt failed",
        });
      }
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
        .prepare(
          "SELECT id, role, name, company, email, stripe_account_id, strike_count, frozen_until, created_at FROM users WHERE id = ?"
        )
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
    const isAdminLogin = data.email.toLowerCase() === ADMIN_DEMO_EMAIL.toLowerCase();
    if (isAdminLogin) {
      if (data.role && data.role !== "admin") {
        return res.status(403).json({ error: "Please use the admin login for this account." });
      }
      if (data.password !== ADMIN_DEMO_PASSWORD) {
        return res.status(401).json({ error: "Email or password is incorrect." });
      }
      const adminUser = {
        id: "admin-demo",
        role: "admin",
        name: ADMIN_DEMO_NAME,
        company: "FillSpace",
        email: ADMIN_DEMO_EMAIL,
        stripe_account_id: "",
        strike_count: 0,
        frozen_until: "",
        created_at: new Date(0).toISOString(),
      };
      issueAuthCookie(res, adminUser);
      return res.json({ user: adminUser });
    }

    if (data.role === "admin") {
      return res.status(403).json({ error: "Please use the admin demo account email to sign in." });
    }

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
    if (isUserFrozen(user)) {
      return res.status(423).json({ error: freezeMessage(user.frozen_until) });
    }
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
        best_for, utilities, buildout, image_url, amenities_json, status,
        requests_paused, cancellation_policy, tax_rate_bps
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      data.status,
      0,
      data.cancellation_policy || "moderate",
      DEFAULT_TAX_RATE_BPS
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
        cancellation_policy = ?,
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
      data.cancellation_policy || "moderate",
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

app.patch(
  "/api/owner/properties/:id/request-settings",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const propertyId = Number(req.params.id);
    if (!Number.isFinite(propertyId)) {
      return res.status(400).json({ error: "We couldn't identify that listing. Please refresh and try again." });
    }
    const parsed = propertyRequestSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please choose valid request settings."),
      });
    }
    const existing = db.prepare("SELECT * FROM properties WHERE id = ? AND owner_id = ?").get(propertyId, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: "We couldn't find that listing in your account." });
    }

    const nextPaused = parsed.data.paused === undefined ? Number(existing.requests_paused || 0) : (parsed.data.paused ? 1 : 0);
    const nextPolicy = parsed.data.cancellation_policy || existing.cancellation_policy || "moderate";
    db.prepare(`
      UPDATE properties
      SET requests_paused = ?, cancellation_policy = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND owner_id = ?
    `).run(nextPaused, nextPolicy, propertyId, req.user.id);

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
        SUM(CASE WHEN status IN ('booking_confirmed', 'confirmed') THEN 1 ELSE 0 END) AS confirmed_reservations,
        COALESCE(SUM(CASE WHEN status IN ('payment_completed', 'documents_pending', 'documents_under_review', 'documents_incomplete', 'booking_confirmed', 'confirmed') THEN total_cents ELSE 0 END), 0) AS gross_cents,
        COALESCE(SUM(CASE WHEN status IN ('payment_completed', 'documents_pending', 'documents_under_review', 'documents_incomplete', 'booking_confirmed', 'confirmed') THEN owner_payout_cents ELSE 0 END), 0) AS payout_cents
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
        COALESCE(SUM(CASE WHEN r.status IN ('payment_completed', 'documents_pending', 'documents_under_review', 'documents_incomplete', 'booking_confirmed', 'confirmed') THEN r.total_cents ELSE 0 END), 0) AS revenue_cents
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
        r.subtotal_cents,
        r.tax_cents,
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
        AND status IN ('payment_completed', 'documents_pending', 'documents_under_review', 'documents_incomplete', 'booking_confirmed', 'confirmed')
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
        AND r.status IN ('payment_completed', 'documents_pending', 'documents_under_review', 'documents_incomplete', 'booking_confirmed', 'confirmed')
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
        r.subtotal_cents,
        r.tax_cents,
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
        subtotal: usdFromCents(row.subtotal_cents || 0),
        tax: usdFromCents(row.tax_cents || 0),
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
        subtotal: usdFromCents(row.subtotal_cents || 0),
        tax: usdFromCents(row.tax_cents || 0),
        total: usdFromCents(row.total_cents),
        platform_fee: usdFromCents(row.platform_fee_cents),
        security_deposit: usdFromCents(row.security_deposit_cents || 0),
      };
      if (
        row.end_date >= now &&
        !["cancelled", "failed", "booking_cancelled", "request_declined", "documents_rejected"].includes(row.status)
      ) {
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
        COALESCE(SUM(CASE WHEN status IN ('payment_completed', 'documents_pending', 'documents_under_review', 'documents_incomplete', 'booking_confirmed', 'confirmed') THEN total_cents ELSE 0 END), 0) AS confirmed_total_cents,
        COALESCE(SUM(CASE WHEN status IN ('payment_completed', 'documents_pending', 'documents_under_review', 'documents_incomplete', 'booking_confirmed', 'confirmed') THEN platform_fee_cents ELSE 0 END), 0) AS platform_fee_total_cents
      FROM reservations
      WHERE tenant_id = ?
    `).get(req.user.id);

    return res.json({
      user: req.user,
      reservations: reservations.map((row) => ({
        ...row,
        subtotal: usdFromCents(row.subtotal_cents || 0),
        tax: usdFromCents(row.tax_cents || 0),
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

app.get(
  "/api/notifications",
  requireAuth,
  runAsync(async (req, res) => {
    if (req.user.role === "admin") {
      return res.json({ notifications: [], unread_count: 0 });
    }
    const rows = db.prepare(`
      SELECT id, reservation_id, type, message, channel, email_to, email_sent, read_at, created_at
      FROM notifications
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `).all(req.user.id);
    const unreadCount = rows.filter((item) => !item.read_at).length;
    return res.json({
      notifications: rows,
      unread_count: unreadCount,
    });
  })
);

app.post(
  "/api/notifications/:id/read",
  requireAuth,
  runAsync(async (req, res) => {
    if (req.user.role === "admin") {
      return res.json({ ok: true });
    }
    const notificationId = Number(req.params.id);
    if (!Number.isFinite(notificationId)) {
      return res.status(400).json({ error: "Invalid notification id." });
    }
    db.prepare(`
      UPDATE notifications
      SET read_at = COALESCE(NULLIF(read_at, ''), ?)
      WHERE id = ? AND user_id = ?
    `).run(nowIso(), notificationId, req.user.id);
    return res.json({ ok: true });
  })
);

app.post(
  "/api/booking-requests",
  requireRole("tenant"),
  runAsync(async (req, res) => {
    const parsed = bookingRequestCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please review your booking request and try again."),
      });
    }
    const data = parsed.data;

    const property = db.prepare("SELECT * FROM properties WHERE id = ? AND status = 'active'").get(data.propertyId);
    if (!property) {
      return res.status(404).json({ error: "We couldn't find that property." });
    }
    if (property.owner_id === req.user.id) {
      return res.status(400).json({ error: "You can't request your own listing." });
    }
    if (Number(property.requests_paused || 0) === 1) {
      return res.status(409).json({ error: "This owner has paused new booking requests for this listing." });
    }

    const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(property.owner_id);
    if (!owner) {
      return res.status(404).json({ error: "We couldn't find the owner for this listing." });
    }
    const ownerStripeStatus = await getStripeStatusForAccountId(owner.stripe_account_id || "");
    if (!ownerStripeStatus.ready) {
      return res.status(409).json({
        error: "This listing isn't ready for payments yet. Please try another listing.",
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

    const cooldownRow = db.prepare(`
      SELECT COALESCE(NULLIF(owner_response_at, ''), updated_at) AS decline_at
      FROM reservations
      WHERE tenant_id = ?
        AND property_id = ?
        AND status = 'request_declined'
      ORDER BY COALESCE(NULLIF(owner_response_at, ''), updated_at) DESC
      LIMIT 1
    `).get(req.user.id, property.id);
    if (cooldownRow?.decline_at) {
      const declineTs = Date.parse(cooldownRow.decline_at);
      if (Number.isFinite(declineTs) && Date.now() - declineTs < DECLINE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000) {
        return res.status(429).json({
          error: "This listing recently declined your request. Please wait one week before submitting again.",
        });
      }
    }

    const openRequest = db.prepare(`
      SELECT id
      FROM reservations
      WHERE tenant_id = ?
        AND property_id = ?
        AND status IN ('request_submitted', 'payment_pending', 'payment_completed', 'documents_pending', 'documents_under_review')
      LIMIT 1
    `).get(req.user.id, property.id);
    if (openRequest) {
      return res.status(409).json({
        error: "You already have an active request for this listing.",
      });
    }

    const pricing = firstMonthChargePlan(property, durationMonths);
    const submittedAt = nowIso();
    const responseDeadline = addHoursIso(submittedAt, BOOKING_RESPONSE_HOURS);
    const insertResult = db.prepare(`
      INSERT INTO reservations (
        property_id, tenant_id, owner_id, start_date, end_date, status,
        total_cents, platform_fee_cents, owner_payout_cents,
        subtotal_cents, tax_cents, months_reserved,
        response_deadline_at, cancellation_policy_snapshot,
        security_deposit_cents, security_deposit_status
      )
      VALUES (?, ?, ?, ?, ?, 'request_submitted', ?, ?, ?, ?, ?, ?, ?, ?, 0, 'none')
    `).run(
      property.id,
      req.user.id,
      property.owner_id,
      data.startDate,
      data.endDate,
      pricing.total_cents,
      pricing.platform_fee_cents,
      pricing.owner_payout_cents,
      pricing.subtotal_cents,
      pricing.tax_cents,
      pricing.months_reserved,
      responseDeadline,
      property.cancellation_policy || "moderate"
    );
    const reservationId = Number(insertResult.lastInsertRowid);
    const reservation = getReservationById(reservationId);
    logReservationAudit({
      reservationId,
      actorUserId: req.user.id,
      actorRole: req.user.role,
      eventType: "request_submitted",
      toStatus: "request_submitted",
      details: {
        response_deadline_at: responseDeadline,
      },
    });

    const ownerMessage = `${userDisplayName(req.user)} submitted a booking request for "${property.title}" (${data.startDate} to ${data.endDate}). You have 48 hours to accept or decline.`;
    const tenantMessage = `Booking request submitted. The owner has 48 hours to respond.`;
    await notifyReservationUsers({
      reservation,
      owner,
      tenant: req.user,
      type: "request_submitted",
      ownerMessage,
      tenantMessage,
      ownerEmailSubject: "New FillSpace booking request",
    });

    return res.status(201).json({
      reservation: {
        ...reservation,
        subtotal: usdFromCents(pricing.subtotal_cents),
        tax: usdFromCents(pricing.tax_cents),
        total: usdFromCents(pricing.total_cents),
      },
    });
  })
);

app.patch(
  "/api/booking-requests/:id",
  requireRole("tenant"),
  runAsync(async (req, res) => {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "Invalid booking request id." });
    }
    const parsed = bookingRequestUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please review your booking dates and try again."),
      });
    }
    const reservation = db
      .prepare("SELECT * FROM reservations WHERE id = ? AND tenant_id = ?")
      .get(reservationId, req.user.id);
    if (!reservation) {
      return res.status(404).json({ error: "We couldn't find that booking request." });
    }
    if (reservation.status !== "request_submitted") {
      return res.status(409).json({ error: "Only pending requests can be edited." });
    }
    const property = db.prepare("SELECT * FROM properties WHERE id = ?").get(reservation.property_id);
    if (!property || property.status !== "active") {
      return res.status(409).json({ error: "This listing is no longer available for edits." });
    }

    const durationMonths = calculateDurationInMonths(parsed.data.startDate, parsed.data.endDate);
    if (!durationMonths) {
      return res.status(400).json({ error: "Please choose an end date that is after the start date." });
    }
    if (durationMonths < property.min_term_months || durationMonths > property.max_term_months) {
      return res.status(400).json({
        error: `Please choose dates that create a term between ${property.min_term_months} and ${property.max_term_months} months.`,
      });
    }
    const pricing = firstMonthChargePlan(property, durationMonths);
    const nextDeadline = addHoursIso(nowIso(), BOOKING_RESPONSE_HOURS);
    db.prepare(`
      UPDATE reservations
      SET
        start_date = ?,
        end_date = ?,
        months_reserved = ?,
        subtotal_cents = ?,
        tax_cents = ?,
        total_cents = ?,
        platform_fee_cents = ?,
        owner_payout_cents = ?,
        response_deadline_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND tenant_id = ?
    `).run(
      parsed.data.startDate,
      parsed.data.endDate,
      durationMonths,
      pricing.subtotal_cents,
      pricing.tax_cents,
      pricing.total_cents,
      pricing.platform_fee_cents,
      pricing.owner_payout_cents,
      nextDeadline,
      reservationId,
      req.user.id
    );

    logReservationAudit({
      reservationId,
      actorUserId: req.user.id,
      actorRole: req.user.role,
      eventType: "request_dates_updated",
      fromStatus: reservation.status,
      toStatus: reservation.status,
      details: {
        start_date: parsed.data.startDate,
        end_date: parsed.data.endDate,
        response_deadline_at: nextDeadline,
      },
    });

    return res.json({
      reservation: getReservationById(reservationId),
      message: "Your request was updated. The owner now has 48 hours to respond.",
    });
  })
);

app.post(
  "/api/booking-requests/:id/cancel",
  requireRole("tenant"),
  runAsync(async (req, res) => {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "Invalid booking request id." });
    }
    const reservation = db
      .prepare("SELECT * FROM reservations WHERE id = ? AND tenant_id = ?")
      .get(reservationId, req.user.id);
    if (!reservation) {
      return res.status(404).json({ error: "We couldn't find that booking request." });
    }

    const owner = userRowById(reservation.owner_id);
    const isBeforePayment = reservation.status === "request_submitted" || reservation.status === "payment_pending";
    const isAfterPayment = [
      "payment_completed",
      "documents_pending",
      "documents_under_review",
      "documents_incomplete",
      "booking_confirmed",
    ].includes(reservation.status);

    if (!isBeforePayment && !isAfterPayment) {
      return res.status(409).json({ error: "This booking request can't be cancelled in its current state." });
    }

    let refundAmount = 0;
    if (isAfterPayment) {
      const policy = String(reservation.cancellation_policy_snapshot || "moderate");
      if (policy === "flexible") {
        refundAmount = Number(reservation.total_cents || 0);
      } else if (policy === "moderate") {
        refundAmount = Math.round(Number(reservation.total_cents || 0) * 0.5);
      } else {
        refundAmount = 0;
      }
      if (refundAmount > 0 && stripe && reservation.stripe_payment_intent_id) {
        await stripe.refunds.create({
          payment_intent: reservation.stripe_payment_intent_id,
          amount: refundAmount,
          metadata: {
            reservationId: String(reservationId),
            reason: "tenant_cancellation",
          },
        });
      }
    }

    const updated = markReservationStatus({
      reservationId,
      nextStatus: "booking_cancelled",
      actorUserId: req.user.id,
      actorRole: req.user.role,
      eventType: "tenant_cancelled_request",
      details: {
        before_payment: isBeforePayment,
        refund_amount_cents: refundAmount,
      },
    });

    let freezeInfo = { strike_count: 0, frozen_until: "" };
    if (isBeforePayment) {
      freezeInfo = incrementStrike(req.user.id, "tenant_cancelled_before_payment", reservationId);
    }

    await notifyReservationUsers({
      reservation: updated,
      owner,
      tenant: req.user,
      type: "tenant_cancelled_request",
      tenantMessage: isBeforePayment
        ? "Your booking request was cancelled. A strike was added to your account for cancelling before payment."
        : `Your booking was cancelled. Refund issued: ${currency(refundAmount)}.`,
      ownerMessage: `${userDisplayName(req.user)} cancelled their booking request.`,
      ownerEmailSubject: "Booking request cancelled",
      tenantEmailSubject: "Booking cancellation processed",
    });

    return res.json({
      reservation: updated,
      refund_amount: usdFromCents(refundAmount),
      strike_count: freezeInfo.strike_count,
      frozen_until: freezeInfo.frozen_until,
    });
  })
);

app.get(
  "/api/tenant/booking-requests",
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
      LIMIT 120
    `).all(req.user.id);
    return res.json({
      requests: rows.map((row) => ({
        ...row,
        subtotal: usdFromCents(row.subtotal_cents || 0),
        tax: usdFromCents(row.tax_cents || 0),
        total: usdFromCents(row.total_cents || 0),
      })),
    });
  })
);

app.get(
  "/api/owner/booking-requests",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const rows = db.prepare(`
      SELECT
        r.*,
        p.title AS property_title,
        p.location AS property_location,
        t.name AS tenant_name,
        t.email AS tenant_email
      FROM reservations r
      JOIN properties p ON p.id = r.property_id
      JOIN users t ON t.id = r.tenant_id
      WHERE r.owner_id = ?
      ORDER BY r.created_at DESC
      LIMIT 200
    `).all(req.user.id);
    const pending = rows.filter((row) => row.status === "request_submitted");
    const inProgress = rows.filter((row) =>
      ["payment_pending", "payment_completed", "documents_pending", "documents_under_review", "documents_incomplete"].includes(row.status)
    );
    const archived = rows.filter((row) => !pending.includes(row) && !inProgress.includes(row));
    return res.json({
      pending_requests: pending,
      active_workflow: inProgress,
      archived,
    });
  })
);

app.post(
  "/api/owner/booking-requests/:id/respond",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "Invalid booking request id." });
    }
    const parsed = ownerBookingDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please choose to accept or decline this request."),
      });
    }
    const reservation = db
      .prepare("SELECT * FROM reservations WHERE id = ? AND owner_id = ?")
      .get(reservationId, req.user.id);
    if (!reservation) {
      return res.status(404).json({ error: "We couldn't find that booking request." });
    }
    if (reservation.status !== "request_submitted") {
      return res.status(409).json({ error: "Only submitted requests can be accepted or declined." });
    }

    const decision = parsed.data.decision;
    const owner = userRowById(reservation.owner_id);
    const tenant = userRowById(reservation.tenant_id);
    const property = db.prepare("SELECT * FROM properties WHERE id = ?").get(reservation.property_id);
    if (!property || property.status !== "active") {
      return res.status(409).json({ error: "This listing is no longer active." });
    }
    const ownerStripeStatus = await getStripeStatusForAccountId(owner?.stripe_account_id || "");
    if (!ownerStripeStatus.ready) {
      return res.status(409).json({ error: "Finish Stripe onboarding before accepting requests." });
    }

    if (decision === "decline") {
      const now = nowIso();
      db.prepare(`
        UPDATE reservations
        SET
          status = 'request_declined',
          owner_response_at = ?,
          owner_response_type = 'decline',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(now, reservationId);
      logReservationAudit({
        reservationId,
        actorUserId: req.user.id,
        actorRole: req.user.role,
        eventType: "request_declined_by_owner",
        fromStatus: reservation.status,
        toStatus: "request_declined",
      });
      const updated = getReservationById(reservationId);
      await notifyReservationUsers({
        reservation: updated,
        owner,
        tenant,
        type: "request_declined",
        tenantMessage: "Your booking request was declined. You can submit a new request for this listing after one week.",
        ownerMessage: "You declined a booking request.",
        tenantEmailSubject: "FillSpace booking request update",
      });
      return res.json({ reservation: updated });
    }

    if (Number(property.requests_paused || 0) === 1) {
      return res.status(409).json({ error: "This listing has paused requests. Unpause it first, then accept." });
    }
    if (reservationHasAcceptedOverlap(property.id, reservation.start_date, reservation.end_date, reservation.id)) {
      return res.status(409).json({
        error: "These dates conflict with an already accepted booking. Please decline this request.",
      });
    }

    const updated = await activatePaymentWindow({
      reservationId,
      owner,
      tenant,
      initiatedBy: "owner_accept",
      actorUserId: req.user.id,
      actorRole: req.user.role,
    });
    return res.json({ reservation: updated });
  })
);

app.post(
  "/api/owner/reservations/:id/cancel",
  requireRole("owner"),
  runAsync(async (req, res) => {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "Invalid reservation id." });
    }
    const reservation = db
      .prepare("SELECT * FROM reservations WHERE id = ? AND owner_id = ?")
      .get(reservationId, req.user.id);
    if (!reservation) {
      return res.status(404).json({ error: "We couldn't find that reservation." });
    }
    const cancellableStatuses = new Set([
      "payment_completed",
      "documents_pending",
      "documents_under_review",
      "documents_incomplete",
      "booking_confirmed",
    ]);
    if (!cancellableStatuses.has(reservation.status)) {
      return res.status(409).json({ error: "This reservation can't be cancelled in its current state." });
    }

    if (stripe && reservation.stripe_payment_intent_id) {
      await stripe.refunds.create({
        payment_intent: reservation.stripe_payment_intent_id,
        amount: Number(reservation.total_cents || 0),
        metadata: {
          reservationId: String(reservationId),
          reason: "owner_cancellation_after_payment",
        },
      });
    }

    const updated = markReservationStatus({
      reservationId,
      nextStatus: "booking_cancelled",
      actorUserId: req.user.id,
      actorRole: req.user.role,
      eventType: "owner_cancelled_after_payment",
      details: { refund_amount_cents: Number(reservation.total_cents || 0) },
    });
    const strikeState = incrementStrike(req.user.id, "owner_cancelled_after_payment", reservationId);
    const tenant = userRowById(reservation.tenant_id);
    const owner = userRowById(reservation.owner_id);

    await notifyReservationUsers({
      reservation: updated,
      owner,
      tenant,
      type: "owner_cancelled_after_payment",
      tenantMessage: "The owner cancelled this reservation. A full refund has been issued.",
      ownerMessage: "You cancelled a paid reservation. A strike was added to your account.",
      tenantEmailSubject: "Reservation cancelled and refunded",
      ownerEmailSubject: "Owner cancellation recorded",
    });

    return res.json({
      reservation: updated,
      owner_strike_count: strikeState.strike_count,
      owner_frozen_until: strikeState.frozen_until,
    });
  })
);

app.get(
  "/api/payments/checkout-link/:token",
  runAsync(async (req, res) => {
    const token = String(req.params.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "Missing payment link token." });
    }
    const reservation = db.prepare(`
      SELECT
        r.*,
        p.title AS property_title,
        p.tax_rate_bps,
        p.status AS property_status,
        t.email AS tenant_email,
        t.name AS tenant_name,
        o.email AS owner_email,
        o.stripe_account_id AS owner_stripe_account_id
      FROM reservations r
      JOIN properties p ON p.id = r.property_id
      JOIN users t ON t.id = r.tenant_id
      JOIN users o ON o.id = r.owner_id
      WHERE r.payment_link_token = ?
      LIMIT 1
    `).get(token);

    if (!reservation) {
      return res.status(404).json({ error: "This payment link is no longer available." });
    }
    if (reservation.status !== "payment_pending") {
      return res.status(409).json({ error: "This payment link is no longer active." });
    }
    if (!stripe) {
      return res.status(501).json({ error: "Online checkout is temporarily unavailable. Please try again later." });
    }
    const deadlineTs = Date.parse(String(reservation.payment_deadline_at || ""));
    if (Number.isFinite(deadlineTs) && Date.now() > deadlineTs) {
      markReservationStatus({
        reservationId: reservation.id,
        nextStatus: "booking_cancelled",
        actorRole: "system",
        eventType: "payment_window_expired",
      });
      return res.status(410).json({ error: "This payment link has expired." });
    }

    const ownerStripeStatus = await getStripeStatusForAccountId(reservation.owner_stripe_account_id || "");
    if (!ownerStripeStatus.ready) {
      return res.status(409).json({ error: "This listing is not ready to accept payment right now." });
    }

    const subtotalCents = Number(reservation.subtotal_cents || reservation.total_cents || 0);
    const taxCents = Number(reservation.tax_cents || 0);
    const totalCents = subtotalCents + taxCents;
    if (totalCents <= 0) {
      return res.status(409).json({ error: "This reservation has an invalid payment amount." });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: reservation.tenant_email,
      success_url: `${BASE_URL}/dashboard-tenant.html?checkout=success&reservation_id=${reservation.id}`,
      cancel_url: `${BASE_URL}/dashboard-tenant.html?checkout=cancelled&reservation_id=${reservation.id}`,
      consent_collection: {
        terms_of_service: "required",
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: subtotalCents,
            product_data: {
              name: `${reservation.property_title} - first month`,
              description: `${reservation.start_date} to ${reservation.end_date}`,
            },
          },
        },
        ...(taxCents > 0
          ? [
              {
                quantity: 1,
                price_data: {
                  currency: "usd",
                  unit_amount: taxCents,
                  product_data: {
                    name: "Estimated taxes",
                    description: "Calculated at booking according to listing tax settings.",
                  },
                },
              },
            ]
          : []),
      ],
      payment_intent_data: {
        metadata: {
          reservationId: String(reservation.id),
          tenantId: String(reservation.tenant_id),
          ownerId: String(reservation.owner_id),
          startDate: String(reservation.start_date),
        },
      },
      metadata: {
        reservationId: String(reservation.id),
      },
    });

    db.prepare(`
      UPDATE reservations
      SET stripe_checkout_session_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(session.id, reservation.id);

    return res.redirect(303, session.url);
  })
);

app.get(
  "/api/reservations/:id/documents",
  requireAuth,
  runAsync(async (req, res) => {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "Invalid reservation id." });
    }
    const reservation = db.prepare("SELECT * FROM reservations WHERE id = ?").get(reservationId);
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found." });
    }
    const isParticipant =
      req.user.role === "admin" ||
      reservation.tenant_id === req.user.id ||
      reservation.owner_id === req.user.id;
    if (!isParticipant) {
      return res.status(403).json({ error: "You don't have access to these documents." });
    }
    const docs = db.prepare(`
      SELECT id, reservation_id, uploaded_by_user_id, party, document_type, file_name, file_url, mime_type, size_bytes, status, created_at, updated_at
      FROM reservation_documents
      WHERE reservation_id = ?
      ORDER BY created_at DESC
    `).all(reservationId);
    return res.json({ documents: docs, reservation });
  })
);

app.post(
  "/api/reservations/:id/documents",
  requireAuth,
  runAsync(async (req, res) => {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "Invalid reservation id." });
    }
    const reservation = db.prepare("SELECT * FROM reservations WHERE id = ?").get(reservationId);
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found." });
    }
    if (![reservation.tenant_id, reservation.owner_id].includes(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ error: "You don't have permission to upload documents here." });
    }
    const parsed = reservationDocumentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please review document details and try again."),
      });
    }

    const party = parsed.data.party;
    if (req.user.role === "tenant" && party !== "tenant") {
      return res.status(403).json({ error: "Tenant uploads must be marked as tenant documents." });
    }
    if (req.user.role === "owner" && party !== "owner") {
      return res.status(403).json({ error: "Owner uploads must be marked as owner documents." });
    }

    db.prepare(`
      INSERT INTO reservation_documents (
        reservation_id, uploaded_by_user_id, party, document_type, file_name, file_url, mime_type, size_bytes, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploaded')
    `).run(
      reservationId,
      req.user.id,
      party,
      parsed.data.document_type,
      parsed.data.file_name,
      parsed.data.file_url,
      parsed.data.mime_type || "",
      Number(parsed.data.size_bytes || 0)
    );
    logReservationAudit({
      reservationId,
      actorUserId: req.user.role === "admin" ? null : req.user.id,
      actorRole: req.user.role,
      eventType: "document_uploaded",
      fromStatus: reservation.status,
      toStatus: reservation.status,
      details: {
        party,
        document_type: parsed.data.document_type,
        file_name: parsed.data.file_name,
        accepted_terms: true,
      },
    });

    const now = nowIso();
    if (party === "tenant") {
      db.prepare(`
        UPDATE reservations
        SET tenant_documents_submitted_at = COALESCE(NULLIF(tenant_documents_submitted_at, ''), ?), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(now, reservationId);
    } else if (party === "owner") {
      db.prepare(`
        UPDATE reservations
        SET owner_documents_submitted_at = COALESCE(NULLIF(owner_documents_submitted_at, ''), ?), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(now, reservationId);
    }

    const refreshed = getReservationById(reservationId);
    const bothSubmitted = Boolean(refreshed?.tenant_documents_submitted_at && refreshed?.owner_documents_submitted_at);
    if (bothSubmitted && ["documents_pending", "documents_incomplete", "payment_completed"].includes(refreshed.status)) {
      db.prepare(`
        UPDATE reservations
        SET
          status = 'documents_under_review',
          documents_status = 'under_review',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(reservationId);
      logReservationAudit({
        reservationId,
        actorUserId: req.user.id,
        actorRole: req.user.role,
        eventType: "documents_submitted_for_review",
        fromStatus: refreshed.status,
        toStatus: "documents_under_review",
      });
    }

    const owner = userRowById(reservation.owner_id);
    const tenant = userRowById(reservation.tenant_id);
    await notifyReservationUsers({
      reservation: refreshed,
      owner,
      tenant,
      type: "document_uploaded",
      tenantMessage: party === "tenant" ? "Your document upload was saved." : "Owner uploaded a document.",
      ownerMessage: party === "owner" ? "Your document upload was saved." : "Tenant uploaded a document.",
    });

    return res.status(201).json({
      reservation: getReservationById(reservationId),
      documents: db.prepare("SELECT * FROM reservation_documents WHERE reservation_id = ? ORDER BY created_at DESC").all(reservationId),
    });
  })
);

app.get(
  "/api/reservations/:id/audit.csv",
  requireAuth,
  runAsync(async (req, res) => {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "Invalid reservation id." });
    }
    const reservation = db.prepare("SELECT * FROM reservations WHERE id = ?").get(reservationId);
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found." });
    }
    const isParticipant =
      req.user.role === "admin" ||
      reservation.tenant_id === req.user.id ||
      reservation.owner_id === req.user.id;
    if (!isParticipant) {
      return res.status(403).json({ error: "You don't have access to this audit report." });
    }

    const auditRows = db.prepare(`
      SELECT created_at, event_type, from_status, to_status, actor_role, details_json
      FROM reservation_audit_logs
      WHERE reservation_id = ?
      ORDER BY created_at ASC
    `).all(reservationId);
    const documentRows = db.prepare(`
      SELECT created_at, party, document_type, file_name, file_url, status
      FROM reservation_documents
      WHERE reservation_id = ?
      ORDER BY created_at ASC
    `).all(reservationId);

    const header = [
      "row_type",
      "created_at",
      "event_type",
      "from_status",
      "to_status",
      "actor_role",
      "details",
      "party",
      "document_type",
      "file_name",
      "file_url",
      "document_status",
    ];
    const lines = [header.join(",")];
    for (const row of auditRows) {
      lines.push(
        [
          "audit",
          csvEscape(row.created_at),
          csvEscape(row.event_type),
          csvEscape(row.from_status),
          csvEscape(row.to_status),
          csvEscape(row.actor_role),
          csvEscape(row.details_json),
          "",
          "",
          "",
          "",
          "",
        ].join(",")
      );
    }
    for (const row of documentRows) {
      lines.push(
        [
          "document",
          csvEscape(row.created_at),
          "document_uploaded",
          "",
          "",
          "",
          "",
          csvEscape(row.party),
          csvEscape(row.document_type),
          csvEscape(row.file_name),
          csvEscape(row.file_url),
          csvEscape(row.status),
        ].join(",")
      );
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"reservation-${reservationId}-audit.csv\"`);
    return res.status(200).send(lines.join("\n"));
  })
);

app.get(
  "/api/admin/reservations/pending-review",
  requireRole("admin"),
  runAsync(async (_req, res) => {
    const rows = db.prepare(`
      SELECT
        r.*,
        p.title AS property_title,
        t.name AS tenant_name,
        o.name AS owner_name
      FROM reservations r
      JOIN properties p ON p.id = r.property_id
      JOIN users t ON t.id = r.tenant_id
      JOIN users o ON o.id = r.owner_id
      WHERE r.status IN ('documents_under_review', 'documents_pending', 'documents_incomplete')
      ORDER BY r.updated_at DESC
      LIMIT 200
    `).all();
    return res.json({ reservations: rows });
  })
);

app.post(
  "/api/admin/reservations/:id/documents/review",
  requireRole("admin"),
  runAsync(async (req, res) => {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "Invalid reservation id." });
    }
    const parsed = adminReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please review the approval details and try again."),
      });
    }
    const reservation = getReservationById(reservationId);
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found." });
    }
    if (!["documents_under_review", "documents_pending", "documents_incomplete"].includes(reservation.status)) {
      return res.status(409).json({ error: "This reservation is not waiting for document review." });
    }

    const now = nowIso();
    const approved = parsed.data.approved;
    const nextStatus = approved ? "booking_confirmed" : "documents_rejected";
    db.prepare(`
      UPDATE reservations
      SET
        status = ?,
        documents_status = ?,
        documents_approved = ?,
        documents_notes = ?,
        documents_reviewed_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      nextStatus,
      approved ? "completed" : "rejected",
      approved ? 1 : 0,
      parsed.data.notes || "",
      now,
      reservationId
    );
    logReservationAudit({
      reservationId,
      actorRole: "admin",
      eventType: approved ? "documents_approved" : "documents_rejected",
      fromStatus: reservation.status,
      toStatus: nextStatus,
      details: { notes: parsed.data.notes || "" },
    });

    const updated = getReservationById(reservationId);
    const owner = userRowById(updated.owner_id);
    const tenant = userRowById(updated.tenant_id);
    await notifyReservationUsers({
      reservation: updated,
      owner,
      tenant,
      type: approved ? "documents_approved" : "documents_rejected",
      tenantMessage: approved
        ? "Your documents were approved. Your booking is now confirmed."
        : "Your documents need attention. FillSpace support will follow up with required fixes.",
      ownerMessage: approved
        ? "Documents were approved and this booking is now confirmed."
        : "Documents were flagged for review. FillSpace support will follow up.",
      tenantEmailSubject: approved ? "Booking confirmed" : "Document review update",
      ownerEmailSubject: approved ? "Booking confirmed" : "Document review update",
    });
    return res.json({ reservation: updated });
  })
);

app.post(
  "/api/admin/reservations/:id/status",
  requireRole("admin"),
  runAsync(async (req, res) => {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "Invalid reservation id." });
    }
    const parsed = adminStatusOverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: formatValidationError(parsed.error, "Please provide a valid status override."),
      });
    }
    const reservation = getReservationById(reservationId);
    if (!reservation) {
      return res.status(404).json({ error: "Reservation not found." });
    }
    const updated = markReservationStatus({
      reservationId,
      nextStatus: parsed.data.status,
      actorRole: "admin",
      eventType: "admin_status_override",
      details: { notes: parsed.data.notes || "" },
    });
    const owner = userRowById(updated.owner_id);
    const tenant = userRowById(updated.tenant_id);
    await notifyReservationUsers({
      reservation: updated,
      owner,
      tenant,
      type: "admin_status_override",
      tenantMessage: `FillSpace updated your reservation status to ${bookingStatusLabel(parsed.data.status)}.`,
      ownerMessage: `FillSpace updated reservation #${updated.id} to ${bookingStatusLabel(parsed.data.status)}.`,
    });
    return res.json({ reservation: updated });
  })
);

app.post(
  "/api/payments/checkout",
  requireRole("tenant"),
  runAsync(async (req, res) => {
    return res.status(409).json({
      error: "Bookings now start with owner review. Please submit a booking request first.",
      next_step: "submit_booking_request",
      endpoint: "/api/booking-requests",
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
    const chargePlan = firstMonthChargePlan(property, months);

    return res.json({
      months,
      subtotal: usdFromCents(chargePlan.subtotal_cents),
      estimated_tax: usdFromCents(chargePlan.tax_cents),
      charged_now: usdFromCents(chargePlan.total_cents),
      platform_fee: usdFromCents(chargePlan.platform_fee_cents),
      owner_payout: usdFromCents(chargePlan.owner_payout_cents),
      cancellation_policy: property.cancellation_policy || "moderate",
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

let automationInProgress = false;

async function processAutoAcceptRequests() {
  const dueRequests = db.prepare(`
    SELECT *
    FROM reservations
    WHERE status = 'request_submitted'
      AND response_deadline_at != ''
      AND response_deadline_at <= ?
    ORDER BY response_deadline_at ASC
    LIMIT 100
  `).all(nowIso());

  for (const reservation of dueRequests) {
    const property = db.prepare("SELECT * FROM properties WHERE id = ?").get(reservation.property_id);
    if (!property || property.status !== "active" || Number(property.requests_paused || 0) === 1) {
      await systemDeclineReservation(
        reservation,
        "system_inactive_listing",
        "Your booking request was automatically declined because the listing is currently unavailable.",
        "A request was automatically declined because the listing is unavailable or requests are paused."
      );
      continue;
    }

    if (reservationHasAcceptedOverlap(property.id, reservation.start_date, reservation.end_date, reservation.id)) {
      await systemDeclineReservation(
        reservation,
        "system_overlap_conflict",
        "Your booking request was automatically declined because the dates are no longer available.",
        "A request was automatically declined due to overlapping accepted dates."
      );
      continue;
    }

    const owner = userRowById(reservation.owner_id);
    const tenant = userRowById(reservation.tenant_id);
    await activatePaymentWindow({
      reservationId: reservation.id,
      owner,
      tenant,
      initiatedBy: "auto_accept",
      actorRole: "system",
    });
  }
}

async function processPaymentRemindersAndExpirations() {
  const rows = db.prepare(`
    SELECT *
    FROM reservations
    WHERE status = 'payment_pending'
      AND payment_deadline_at != ''
    ORDER BY payment_deadline_at ASC
    LIMIT 200
  `).all();

  for (const reservation of rows) {
    const deadline = Date.parse(String(reservation.payment_deadline_at || ""));
    if (!Number.isFinite(deadline)) {
      continue;
    }
    const hoursLeft = (deadline - Date.now()) / (1000 * 60 * 60);
    const owner = userRowById(reservation.owner_id);
    const tenant = userRowById(reservation.tenant_id);

    if (hoursLeft <= 0) {
      const updated = markReservationStatus({
        reservationId: reservation.id,
        nextStatus: "booking_cancelled",
        actorRole: "system",
        eventType: "payment_window_expired",
      });
      await notifyReservationUsers({
        reservation: updated,
        owner,
        tenant,
        type: "payment_window_expired",
        tenantMessage: "Payment window expired, and this booking request was cancelled.",
        ownerMessage: "A booking request expired because payment was not completed in time.",
        tenantEmailSubject: "Payment window expired",
      });
      continue;
    }

    const reminderColumns = {
      36: "reminder_36_sent_at",
      24: "reminder_24_sent_at",
      12: "reminder_12_sent_at",
      2: "reminder_2_sent_at",
    };
    for (const offset of PAYMENT_REMINDER_OFFSETS_HOURS) {
      const column = reminderColumns[offset];
      if (!column) {
        continue;
      }
      const alreadySent = String(reservation[column] || "").trim();
      if (alreadySent) {
        continue;
      }
      if (hoursLeft <= offset) {
        const reminderText =
          `Payment reminder: your booking request will expire in about ${Math.max(1, Math.round(hoursLeft))} hour(s). ` +
          `Pay now: ${reservationPaymentLink(reservation.payment_link_token)}`;
        await notifyReservationUsers({
          reservation,
          owner,
          tenant,
          type: "payment_reminder",
          tenantMessage: reminderText,
          ownerMessage: "A payment reminder was sent to the tenant.",
          tenantEmailSubject: "Payment reminder from FillSpace",
        });
        db.prepare(`
          UPDATE reservations
          SET ${column} = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(nowIso(), reservation.id);
      }
    }
  }
}

async function processDocumentDeadlines() {
  const rows = db.prepare(`
    SELECT *
    FROM reservations
    WHERE status IN ('payment_completed', 'documents_pending', 'documents_incomplete')
      AND documents_due_at != ''
      AND documents_due_at <= ?
    ORDER BY documents_due_at ASC
    LIMIT 200
  `).all(nowIso());
  for (const reservation of rows) {
    const bothSubmitted = Boolean(reservation.tenant_documents_submitted_at && reservation.owner_documents_submitted_at);
    if (bothSubmitted) {
      continue;
    }
    const updated = markReservationStatus({
      reservationId: reservation.id,
      nextStatus: "documents_incomplete",
      actorRole: "system",
      eventType: "documents_deadline_missed",
    });
    const owner = userRowById(reservation.owner_id);
    const tenant = userRowById(reservation.tenant_id);
    await notifyReservationUsers({
      reservation: updated,
      owner,
      tenant,
      type: "documents_deadline_missed",
      tenantMessage: "Document deadline passed. Please contact FillSpace support to continue this booking.",
      ownerMessage: "Document deadline passed for this booking request.",
      tenantEmailSubject: "Document deadline missed",
      ownerEmailSubject: "Booking documents overdue",
    });
  }
}

async function processPayoutReleases() {
  if (!stripe) {
    return;
  }
  const rows = db.prepare(`
    SELECT *
    FROM reservations
    WHERE status IN ('booking_confirmed', 'confirmed')
      AND payout_available_at != ''
      AND payout_available_at <= ?
      AND payout_released_at = ''
      AND owner_payout_cents > 0
    ORDER BY payout_available_at ASC
    LIMIT 100
  `).all(nowIso());

  for (const reservation of rows) {
    const owner = userRowById(reservation.owner_id);
    if (!owner?.stripe_account_id) {
      continue;
    }
    const ownerStripeStatus = await getStripeStatusForAccountId(owner.stripe_account_id);
    if (!ownerStripeStatus.ready) {
      continue;
    }

    try {
      const transfer = await stripe.transfers.create({
        amount: Number(reservation.owner_payout_cents || 0),
        currency: "usd",
        destination: owner.stripe_account_id,
        metadata: {
          reservationId: String(reservation.id),
          payoutRule: "3_days_after_move_in",
        },
      });
      db.prepare(`
        UPDATE reservations
        SET
          stripe_transfer_id = ?,
          stripe_transfer_status = 'paid',
          payout_released_at = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(transfer.id, nowIso(), reservation.id);
      logReservationAudit({
        reservationId: reservation.id,
        actorRole: "system",
        eventType: "owner_payout_released",
        fromStatus: reservation.status,
        toStatus: reservation.status,
        details: {
          transfer_id: transfer.id,
          amount_cents: Number(reservation.owner_payout_cents || 0),
        },
      });
      const tenant = userRowById(reservation.tenant_id);
      await notifyReservationUsers({
        reservation,
        owner,
        tenant,
        type: "owner_payout_released",
        tenantMessage: "Owner payout was released for this booking.",
        ownerMessage: `Your payout of ${currency(reservation.owner_payout_cents || 0)} has been released.`,
        ownerEmailSubject: "Owner payout released",
      });
    } catch (error) {
      db.prepare(`
        UPDATE reservations
        SET stripe_transfer_status = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(reservation.id);
      console.error("Payout release failed:", error?.message || error);
    }
  }
}

async function processReservationAutomation() {
  if (automationInProgress) {
    return;
  }
  automationInProgress = true;
  try {
    await processAutoAcceptRequests();
    await processPaymentRemindersAndExpirations();
    await processDocumentDeadlines();
    await processPayoutReleases();
  } catch (error) {
    console.error("Automation loop failed:", error?.message || error);
  } finally {
    automationInProgress = false;
  }
}

function startAutomationScheduler() {
  setTimeout(() => {
    processReservationAutomation().catch(() => {});
  }, 5000);
  setInterval(() => {
    processReservationAutomation().catch(() => {});
  }, AUTOMATION_POLL_MS);
}

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
  console.log(`Automation scheduler: every ${Math.round(AUTOMATION_POLL_MS / 1000)}s`);
  startAutomationScheduler();
});

