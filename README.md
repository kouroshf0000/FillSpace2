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

## Environment variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required for marketplace payments:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET` (optional but recommended for webhook signature validation)

## Demo credentials

Seeded local demo users:

- Owner: `owner@fillspace.com` / `Owner123!`
- Tenant: `tenant@fillspace.com` / `Tenant123!`

## Backend highlights

- **Auth**: JWT in httpOnly cookie (`owner` and `tenant` roles)
- **Owner dashboard**:
  - full property creation form,
  - listing management,
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
- `GET /api/properties`
- `POST /api/owner/properties`
- `GET /api/owner/dashboard`
- `GET /api/tenant/dashboard`
- `POST /api/tenant/favorites/:propertyId`
- `POST /api/payments/checkout`
- `POST /api/payments/webhook`

## Design notes

- Font stack includes Airbnb Cereal (`Airbnb Cereal App`) with system fallbacks.
- Brand palette is matched to the deck PDF and centralized in `assets/css/style.css`.
- Contact CTAs route users to `ask-info.html`.
- Inquiry submissions post to `https://formsubmit.co/hello@fillspace.com`.

