# FillSpace Marketplace MVP

A multi-page FillSpace MVP with:

- polished marketing website (Airbnb-style UX patterns),
- role-based owner and tenant authentication,
- admin demo override authentication,
- owner and tenant dashboards,
- dynamic property API-backed browse experience,
- Stripe Connect marketplace payment flow (12% platform fee model),
- request-first booking lifecycle (owner review within 48h, auto-accept fallback, email payment links, docs workflow).

## Pages

- `index.html` - Home
- `about.html` - About
- `browse.html` - Browse Properties
- `ask-info.html` - Contact / inquiry form
- `owner-login.html` - Owner authentication portal
- `tenant-login.html` - Tenant authentication portal
- `dashboard-owner.html` - Owner dashboard
- `dashboard-tenant.html` - Tenant dashboard
- `admin-login.html` - Admin authentication portal
- `admin-dashboard.html` - Admin review and override dashboard
- `connect.html` - Stripe Connect sample dashboard
- `storefront.html` - Connected account storefront sample
- `done.html` - Stripe checkout completion page

## Quick start (important)

Run the backend server (which also serves the frontend):

```bash
npm install
npm run dev
```

Then visit:

```text
http://localhost:4173
```

## Deploying on Render

Use a **Web Service** (Node) with:

- **Build command**: `npm ci && npm run build`
- **Start command**: `npm start`

If your service currently uses `npm run build` and fails, this repo now includes a build script (`npm run test`) so Render build will pass.

Recommended Render settings:

- Node version: `20` (compatible with `better-sqlite3`)
- Health check path: `/api/health`
- Add all required env vars from `.env.example`

For SQLite persistence on Render, mount a disk at:

- `/opt/render/project/src/data`

## Environment variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required for marketplace payments:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET` (optional but recommended for webhook signature validation)
- `SECURITY_DEPOSIT_USD` (optional; defaults to `500`)
- `DEFAULT_TAX_RATE_BPS` (optional; defaults to `625`)

Optional admin override credentials:

- `ADMIN_DEMO_EMAIL`
- `ADMIN_DEMO_PASSWORD`
- `ADMIN_DEMO_NAME`

Required for direct inquiry delivery and owner listing notification emails:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `INQUIRY_EMAIL_TO` (defaults to `kouroshf08@gmail.com`)
- `LISTING_NOTIFY_EMAIL_TO` (owner new-listing alerts)

Optional inquiry fallback (if SMTP is not configured):

- `INQUIRY_FORWARD_ENABLED`
- `INQUIRY_FORWARD_URL`

### Recommended setup for reliable inquiry emails

For best deliverability and lowest spam risk, use SMTP via a transactional email provider (Resend, Postmark, or SendGrid) instead of form-forwarding services.

1. Set `INQUIRY_EMAIL_TO=kouroshf08@gmail.com`.
2. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS` from your provider.
3. Use a verified sending domain for `INQUIRY_EMAIL_FROM` (for example `leads@fillspace.com`).
4. Add SPF, DKIM, and DMARC records for your sending domain.
5. Keep `INQUIRY_FORWARD_ENABLED=false` once SMTP is working.

## Demo credentials

Seeded local demo users:

- Owner: `owner@fillspace.com` / `Owner123!`
- Tenant: `tenant@fillspace.com` / `Tenant123!`
- Admin: `admin@fillspace.com` / `Admin123!`

## Backend highlights

- **Auth**: JWT in httpOnly cookie (`owner`, `tenant`, and demo `admin` roles)
- **Owner dashboard**:
  - full property creation form,
  - listing management,
  - request pause toggle and cancellation policy controls,
  - booking request accept/decline actions,
  - immediate publish to browse results on creation,
  - optional email alert when new listings are published,
  - analytics snapshot,
  - finance transactions,
  - tax/legal document references,
  - Stripe Connect onboarding entrypoint.
- **Tenant dashboard**:
  - upcoming reservations,
  - request submission/edit/cancel workflow,
  - request timeline with response/payment deadlines,
  - reservation history,
  - finance/tax table,
  - watchlist/favorites management,
  - document upload flow (tenant side).
- **Public browse**:
  - reads from `/api/properties`,
  - includes owner-added properties automatically.
- **Payments**:
  - request accepted -> email payment link -> Stripe Checkout,
  - first month charged up front (plus estimated taxes),
  - 12% platform fee retained by FillSpace,
  - owner payout released 3 days after move-in via scheduled transfer.

## Key API routes

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/inquiries`
- `GET /api/properties`
- `POST /api/owner/properties`
- `GET /api/owner/dashboard`
- `GET /api/owner/booking-requests`
- `POST /api/owner/booking-requests/:id/respond`
- `POST /api/owner/reservations/:id/cancel`
- `GET /api/owner/inquiries`
- `GET /api/tenant/dashboard`
- `GET /api/tenant/booking-requests`
- `POST /api/booking-requests`
- `PATCH /api/booking-requests/:id`
- `POST /api/booking-requests/:id/cancel`
- `POST /api/tenant/favorites/:propertyId`
- `GET /api/payments/checkout-link/:token`
- `POST /api/payments/webhook`
- `GET /api/notifications`
- `POST /api/notifications/:id/read`
- `GET /api/reservations/:id/documents`
- `POST /api/reservations/:id/documents`
- `GET /api/reservations/:id/audit.csv`
- `GET /api/admin/reservations/pending-review`
- `POST /api/admin/reservations/:id/documents/review`
- `POST /api/admin/reservations/:id/status`
- `POST /api/create-connect-account`
- `POST /api/create-account-link`
- `GET /api/account-status/:accountId`
- `GET /api/account-login-link/:accountId`
- `POST /api/create-product`
- `GET /api/products/:accountId`
- `POST /api/create-checkout-session`
- `GET /api/owner/tax/1099-summary`
- `GET /api/owner/tax/1099.csv`

## Design notes

- Font stack includes Airbnb Cereal (`Airbnb Cereal App`) with system fallbacks.
- Brand palette is matched to the deck PDF and centralized in `assets/css/style.css`.
- Contact CTAs route users to `ask-info.html`.
- Ask-info submissions post to backend `POST /api/inquiries`, are saved in SQLite, and deliver via SMTP when configured.

