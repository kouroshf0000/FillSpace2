# FillSpace Marketplace MVP

A multi-page FillSpace MVP with:

- polished marketing website (Airbnb-style UX patterns),
- role-based owner and tenant authentication,
- owner and tenant dashboards,
- dynamic property API-backed browse experience,
- Stripe Connect marketplace payment flow (12% platform fee model).

## Pages

- `index.html` - Home
- `about.html` - About
- `browse.html` - Browse Properties
- `ask-info.html` - Contact / inquiry form
- `owner-login.html` - Owner authentication portal
- `tenant-login.html` - Tenant authentication portal
- `dashboard-owner.html` - Owner dashboard
- `dashboard-tenant.html` - Tenant dashboard
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

## Backend highlights

- **Auth**: JWT in httpOnly cookie (`owner` and `tenant` roles)
- **Owner dashboard**:
  - full property creation form,
  - listing management,
  - immediate publish to browse results on creation,
  - optional email alert when new listings are published,
  - analytics snapshot,
  - finance transactions,
  - tax/legal document references,
  - Stripe Connect onboarding entrypoint.
- **Tenant dashboard**:
  - upcoming reservations,
  - reservation history,
  - finance/tax table,
  - watchlist/favorites management,
  - Stripe checkout booking flow.
- **Public browse**:
  - reads from `/api/properties`,
  - includes owner-added properties automatically.
- **Payments**:
  - Stripe Checkout with Connect transfer destination,
  - 12% application/platform fee retained by FillSpace,
  - owner payout routed through Stripe destination account.

## Key API routes

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/inquiries`
- `GET /api/properties`
- `POST /api/owner/properties`
- `GET /api/owner/dashboard`
- `GET /api/owner/inquiries`
- `GET /api/tenant/dashboard`
- `POST /api/tenant/favorites/:propertyId`
- `POST /api/payments/checkout`
- `POST /api/payments/webhook`
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

