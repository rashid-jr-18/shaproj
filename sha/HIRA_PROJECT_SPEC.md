# Hira – E-commerce Application: Full Project Specification

> Version 1.0 · Status: Ready for build · Owner: Hira team
> This document is the single source of truth for architecture, business rules, security and design.

---

## 1. Project Summary

**Hira** is an online shopping application (Amazon-style, but small and focused).

| Item | Decision |
|---|---|
| App name | **Hira** |
| Users | Customers (many) and **one Admin** (single store owner) |
| Initial catalog | ~50 products |
| Architecture | **Microservices**, built module by module |
| Devices | Mobile, tablet, desktop; all modern browsers including iPhone Safari |
| Security baseline | OWASP Top 10 and OWASP ASVS (Level 1 for launch, Level 2 for payment and auth) |
| Design | Warm, human colours. No AI-looking gradients or purple neon |

### 1.1 What the admin can do
1. Add, edit and delete (archive) products.
2. Set stock quantity, restock, and mark a product unavailable.
3. See all orders, check them, and **start delivery** (confirm → pack → ship → deliver).
4. Handle cancellations, returns and refunds.

### 1.2 What the customer can do
Browse, search, filter, view product, add to cart, checkout, pay, track order, cancel (before shipping), return (after delivery), manage profile and addresses.

### 1.3 Honest architecture note
With 50 products and one admin, microservices are more than you need on day one. But since the decision is made, we do it **properly**: each service owns its own database, services talk through an API gateway and an event bus, and we build in the order given in Section 17. Keep the number of services small at the start (Section 4) and split further only when real load demands it.

---

## 2. How Successful Platforms Work (Reference Patterns)

This section distills the common patterns used by mature platforms such as Amazon, Shopify, and open-source commerce engines (Medusa, Saleor). Before build, the team should also read the official documentation of one open-source engine (Medusa or Saleor docs) to cross-check the flows below.

### 2.1 The standard commerce flow
```
Browse → Product page → Cart → Checkout (address + shipping + payment)
      → Order created → Payment confirmed → Admin/fulfilment
      → Packed → Shipped → Delivered → (Return / Refund)
```

### 2.2 Patterns every serious platform uses

1. **Catalog is separate from inventory.** A product (name, description, images, price) is one thing; "how many are available" is another. Inventory changes constantly and must be strongly consistent.
2. **Stock reservation at checkout.** When a customer starts paying, items are *reserved* for a short time (10–15 min). If payment fails or time expires, the reservation is released. This prevents two people buying the last piece.
3. **Atomic stock decrement.** Stock is decreased in one database operation that checks and updates together, never "read then write".
4. **Order is a state machine.** An order moves only through allowed states. Illegal jumps are rejected.
5. **Price snapshot.** The order stores the price, name, tax at the time of purchase. Later price changes never alter old orders.
6. **Payment webhooks are the truth.** The browser redirect can lie or drop. The payment gateway's server-to-server webhook confirms payment. Webhooks are verified by signature and are idempotent.
7. **Idempotency keys.** Checkout and payment requests carry a unique key so a double-click or network retry never creates two orders or two charges.
8. **Soft delete.** Products and orders are never hard-deleted; they are archived to keep history intact.
9. **Audit log.** Every admin action (price change, stock change, order status change) is recorded with who, when, before and after.
10. **Events for side effects.** After "order placed", emails, notifications and analytics are triggered through events, not inside the checkout request.

---

## 3. Stock Rules (Most Important Business Logic)

### 3.1 Your example, exactly
```
Product: Cotton Kurta    Stock = 5      → shown as "Available"
Customer A buys 3        Stock = 2      → still "Available" (only 2 left)
Customer B buys 2        Stock = 0      → shown as "Out of stock"
Admin restocks +10       Stock = 10     → shown as "Available" again
```

### 3.2 Two numbers per product (not one)
| Field | Meaning |
|---|---|
| `on_hand` | Physically in the store |
| `reserved` | Held by carts in checkout or unpaid orders |
| `available` | `on_hand − reserved` (what customers can still buy) |

When payment succeeds, `reserved` converts into a real deduction from `on_hand`. When payment fails or expires, `reserved` is released.

### 3.3 Product availability states
| State | Rule | Customer sees |
|---|---|---|
| `IN_STOCK` | available > low-stock threshold | "In stock" |
| `LOW_STOCK` | 1 ≤ available ≤ threshold (default 3) | "Only 2 left" |
| `OUT_OF_STOCK` | available = 0 | "Out of stock", Add to cart disabled, optional "Notify me" |
| `UNAVAILABLE` | Admin switched off manually | Hidden or "Currently unavailable" |
| `ARCHIVED` | Soft-deleted | Not visible; old orders still show it |

### 3.4 Atomic update (prevents overselling)
```sql
-- reserve stock at checkout; succeeds only if enough is available
UPDATE inventory
SET reserved = reserved + :qty
WHERE product_id = :id
  AND (on_hand - reserved) >= :qty;
-- rows affected = 0  →  not enough stock, reject with a clear message
```
Run the whole cart reservation inside one transaction so a 3-item cart either reserves everything or nothing.

### 3.5 Stock edge cases
- Two customers press "Buy" for the last piece at the same moment: only one reservation succeeds; the other gets "Just sold out".
- Customer abandons checkout: reservation expires (scheduler job releases it).
- Payment succeeds after reservation expired: re-check stock; if gone, auto-refund and notify (rare, must be handled).
- Order cancelled before shipping: stock returns automatically.
- Return received and inspected: admin chooses "restock" or "write off (damaged)".
- Admin edits stock while reservations exist: `on_hand` can never be set below `reserved`.
- Negative stock is impossible (database `CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand)`).
- Cart items are **not** reserved while just sitting in the cart; the cart shows a warning if stock fell, and checkout re-validates.
- Every stock movement is logged in `stock_movements` (sale, restock, adjustment, return, cancel, reservation, release).

---

## 4. Architecture

### 4.1 Overview
```
 ┌────────────────────┐        ┌────────────────────┐
 │  Customer Web App  │        │     Admin Panel    │
 │ (Next.js, PWA)     │        │ (React, separate)  │
 └─────────┬──────────┘        └─────────┬──────────┘
           │ HTTPS                       │ HTTPS
           └──────────────┬──────────────┘
                   ┌──────▼───────┐
                   │ API Gateway  │  rate limit · JWT check · CORS · routing
                   └──────┬───────┘
   ┌────────┬────────┬────┴────┬─────────┬──────────┬──────────────┐
   ▼        ▼        ▼         ▼         ▼          ▼              ▼
┌──────┐┌────────┐┌────────┐┌──────┐┌─────────┐┌─────────┐┌──────────────┐
│ Auth ││Catalog ││Inventory││ Cart ││ Order   ││ Payment ││ Notification │
│ User ││ Search ││         ││      ││Fulfil.  ││         ││              │
└──┬───┘└───┬────┘└───┬────┘└──┬───┘└────┬────┘└────┬────┘└──────┬───────┘
   │DB      │DB       │DB      │Redis    │DB        │DB          │DB
   └────────┴─────────┴────────┴─────────┴──────────┴────────────┘
                     Event Bus (RabbitMQ)
```

### 4.2 Services (start with these 8)

| # | Service | Owns | Notes |
|---|---|---|---|
| 1 | **auth-service** | users, credentials, sessions, roles, addresses | Login, register, refresh tokens, password reset, admin role |
| 2 | **catalog-service** | products, categories, images, prices | Read-heavy; cached |
| 3 | **inventory-service** | stock, reservations, stock movements | Strong consistency; the only service that changes stock |
| 4 | **cart-service** | carts | Redis-backed; guest + logged-in carts |
| 5 | **order-service** | orders, order items, status history, returns | State machine lives here |
| 6 | **payment-service** | payments, refunds, webhook log | Wraps the payment gateway |
| 7 | **notification-service** | email / SMS / WhatsApp templates and logs | Event-driven only |
| 8 | **api-gateway** | none | Single public entry point |

Later (optional): search-service (Elasticsearch/Meilisearch), review-service, coupon-service, analytics-service.

### 4.3 Rules between services
1. **Database per service.** No service reads another's tables.
2. **Sync calls** (HTTP/gRPC) only when an answer is needed immediately (e.g., order-service asks inventory-service to reserve stock).
3. **Async events** for everything else (e.g., `order.paid` → notification, inventory finalize).
4. **Saga pattern** for checkout (Section 6.2): each step has a compensating action.
5. **Outbox pattern** so a database commit and its event are never out of sync.
6. Every service exposes `/health` and `/ready`.
7. Every request carries a `X-Correlation-Id` for tracing across services.

### 4.4 Technology stack (cross-browser and iPhone safe)

| Layer | Choice | Why |
|---|---|---|
| Customer frontend | **Next.js (React) + TypeScript** | SSR for SEO and speed; works on all browsers |
| Admin frontend | **React + Vite + TypeScript** | Separate app, separate URL, separate login |
| Styling | **Tailwind CSS** with design tokens (Section 9) | Consistent, small CSS |
| Backend | **Node.js + NestJS (TypeScript)** | Modular by nature, great for microservices |
| Database | **PostgreSQL** (one per service) | Transactions, constraints, reliability |
| Cache / carts | **Redis** | Fast, TTL for carts and rate limits |
| Messaging | **RabbitMQ** | Simple, reliable for this scale |
| Images | **S3-compatible storage + CDN**, auto-resized WebP/JPEG | Fast on mobile |
| Payments | **Razorpay** (India: UPI, cards, netbanking) + Cash on Delivery option | Webhook-based confirmation |
| Email / SMS | SES/SendGrid, MSG91 | Order updates |
| Containers | Docker, Docker Compose (dev), Kubernetes or managed containers (prod) | |
| CI/CD | GitHub Actions | Test, scan, build, deploy |
| Monitoring | Prometheus + Grafana, Sentry, structured logs (Loki/ELK) | |

**Browser support (browserslist):** last 2 versions of Chrome, Edge, Firefox, Safari; **iOS Safari 15+**, Chrome Android, Samsung Internet. No feature is used without a fallback.

---

## 5. Data Model (per service, essential tables)

### auth-service
- `users` (id, name, email, phone, password_hash, role [`CUSTOMER` | `ADMIN`], status, email_verified_at, failed_attempts, locked_until)
- `addresses` (id, user_id, name, phone, line1, line2, city, state, pincode, is_default)
- `refresh_tokens` (id, user_id, token_hash, expires_at, revoked_at, device_info)

### catalog-service
- `categories` (id, name, slug, parent_id)
- `products` (id, sku, name, slug, description, category_id, price, mrp, tax_rate, status [`ACTIVE` | `UNAVAILABLE` | `ARCHIVED`], created_at, updated_at, deleted_at)
- `product_images` (id, product_id, url, alt, sort_order)
- `product_variants` (optional later: size, colour; each variant has its own SKU and stock)

### inventory-service
- `inventory` (product_id PK, on_hand, reserved, low_stock_threshold) with CHECK constraints from Section 3.4
- `reservations` (id, order_ref, product_id, qty, status [`HELD` | `CONFIRMED` | `RELEASED` | `EXPIRED`], expires_at)
- `stock_movements` (id, product_id, type, qty_change, reason, actor_id, order_ref, created_at)

### order-service
- `orders` (id, order_no, user_id, status, subtotal, tax, shipping_fee, discount, total, address_snapshot JSON, payment_method, idempotency_key UNIQUE, created_at)
- `order_items` (id, order_id, product_id, name_snapshot, sku_snapshot, unit_price_snapshot, qty, line_total)
- `order_status_history` (id, order_id, from_status, to_status, actor_id, note, created_at)
- `returns` (id, order_id, reason, status, refund_amount)

### payment-service
- `payments` (id, order_id, gateway, gateway_payment_id, amount, currency, status, method, created_at)
- `refunds` (id, payment_id, amount, status, reason)
- `webhook_events` (id, gateway_event_id UNIQUE, payload, processed_at) – dedupe

### notification-service
- `templates`, `notification_log`

### Money rule
Store money as **integer paise** (₹499.50 = 49950). Never use floating point.

---

## 6. Core Flows

### 6.1 Order status state machine
```
PENDING_PAYMENT ──paid──► CONFIRMED ──admin──► PROCESSING ──► SHIPPED ──► DELIVERED
      │                       │                    │                         │
      │expired/failed         │cancel              │cancel                   │return request
      ▼                       ▼                    ▼                         ▼
   CANCELLED               CANCELLED            CANCELLED             RETURN_REQUESTED
                          (refund + restock)   (refund + restock)            │
                                                                             ▼
                                                            RETURN_APPROVED → RETURNED → REFUNDED
```
- COD orders skip `PENDING_PAYMENT` and go straight to `CONFIRMED` (with COD fraud limits, see 7.2).
- After `SHIPPED`, customer cannot cancel; they must use return after delivery.
- Each transition is validated server-side, logged in `order_status_history`, and emits an event.

### 6.2 Checkout saga (what happens when "Place order" is pressed)
```
1. Client sends POST /orders with Idempotency-Key
2. order-service validates cart, prices, address (server re-calculates; never trusts client price)
3. order-service → inventory-service: RESERVE all items (atomic)
      fail → return "X is out of stock" (nothing reserved)
4. order-service creates order = PENDING_PAYMENT
5. payment-service creates gateway order, returns payment info to client
6. Customer pays on the gateway
7. Gateway webhook → payment-service (signature verified, deduped)
8. payment-service emits payment.succeeded
9. order-service → CONFIRMED; inventory-service finalizes reservation (on_hand −qty)
10. notification-service sends confirmation; admin sees new order
    ── Failure paths ──
    payment failed / reservation expired → order CANCELLED, reservation RELEASED
    stock gone when payment arrives late → auto refund + apology notification
```

### 6.3 Admin order handling
1. New order appears in **"Needs action"** list (status `CONFIRMED`) with a badge and sound/notification.
2. Admin opens order, verifies items, address, payment status.
3. Admin clicks **Start processing** → `PROCESSING`.
4. After packing, **Mark as shipped** with courier name and tracking number → `SHIPPED`; customer notified.
5. **Mark as delivered** (or auto via courier webhook later) → `DELIVERED`.
6. Admin can cancel before shipping (reason required, refund triggered automatically).
7. Admin handles return requests: approve / reject, then receive and choose restock or write-off.

### 6.4 Admin product handling
- Add product: name, description, category, price, MRP, images (up to 6), stock, low-stock threshold, status.
- Edit price: affects only new orders.
- Switch **Unavailable** toggle: product disappears from listing instantly (cache invalidated); existing orders unaffected.
- Restock: "Add stock" form (+qty and note), shows before/after; logged.
- Bulk import of the first 50 products via CSV (validate every row, show errors before saving).
- Delete = archive. Cannot archive silently if open orders exist; warn the admin.

---

## 7. Edge Cases Checklist

### 7.1 Orders and payment
- Double-click on Pay: idempotency key returns the same order.
- Payment succeeds but customer closes the browser: webhook still confirms the order.
- Webhook arrives twice or out of order: dedupe by `gateway_event_id`, ignore older states.
- Webhook with invalid signature: reject, alert.
- Amount mismatch between order and gateway: flag order for manual review, do not confirm.
- Customer changes address after ordering: allowed only until `PROCESSING`.
- Price changes between cart and checkout: show "price updated" and ask to confirm.
- Product becomes unavailable or archived while in cart: show clearly, block checkout for that item.
- Partial refund on a partially returned order.
- Order stuck in `PENDING_PAYMENT` over 30 min: auto-cancel job.

### 7.2 Cash on Delivery
- Limit COD order value (e.g., ₹5,000) and require phone OTP verification.
- Block COD for phone numbers with repeated refused deliveries.

### 7.3 Accounts
- Guest checkout allowed? **Decision needed** (recommended: allow, with email + phone).
- Merge guest cart into user cart at login.
- Duplicate email registration, case-insensitive email matching.
- Account lockout after repeated failed logins (progressive delay).
- Deleting account: anonymise personal data, keep order records for legal retention.

### 7.4 Operational
- Admin accidentally sets wrong stock: stock movement log + undo via correction entry.
- Single admin account lost: documented recovery procedure and a second break-glass admin stored securely.
- Timezone: store UTC, show IST.
- Pincode serviceability check at checkout.
- Tax (GST) calculation and invoice PDF generation per order.
- Product images missing or slow: placeholder and lazy loading.
- Search with typos, Tamil and English terms.
- Large order volume spike (sale day): rate limits, queue-based processing, read replicas/cache.

---

## 8. Security Specification (OWASP-aligned)

Security is a requirement from sprint 1, not a final phase. The mapping below follows the OWASP Top 10 categories (2021 list names are shown). Before launch, check the latest published OWASP Top 10 edition and ASVS and update this table if categories changed.

| OWASP risk | What Hira does |
|---|---|
| **A01 Broken Access Control** | Role check (`CUSTOMER` / `ADMIN`) on every endpoint, enforced in each service and not only the gateway. Ownership check on every resource (customer can only read own orders, addresses, carts) to prevent IDOR. Deny by default. Use unguessable IDs (UUID) in public URLs. Admin app on a separate domain with IP allow-list option and mandatory 2FA. |
| **A02 Cryptographic Failures** | HTTPS only, TLS 1.2+, HSTS. Passwords hashed with **Argon2id** (or bcrypt cost ≥ 12). Secrets in a secrets manager, never in git. Encrypt DB at rest and backups. No card data stored (gateway handles it, keeping us out of PCI heavy scope). |
| **A03 Injection** | Parameterised queries / ORM only. Strict input validation (DTO schemas, allow-lists, length limits) on every endpoint. Output encoding in the UI. Validate and sanitise uploaded file names. |
| **A04 Insecure Design** | Threat modelling per module before coding. Business-logic abuse cases tested: negative quantity, price tampering, coupon stacking, reservation hoarding, COD abuse. Server recalculates all prices and totals. |
| **A05 Security Misconfiguration** | Hardened containers (non-root, minimal images). Security headers: CSP, X-Content-Type-Options, X-Frame-Options/frame-ancestors, Referrer-Policy, Permissions-Policy. CORS allow-list. Disable stack traces and debug in production. Remove default credentials. |
| **A06 Vulnerable and Outdated Components** | Dependabot/Renovate, `npm audit` and Trivy scans in CI, lockfiles committed, SBOM generated, block merges on critical vulnerabilities. |
| **A07 Identification and Authentication Failures** | Short-lived access token (10–15 min) + rotating refresh token (stored hashed, revocable). httpOnly + Secure + SameSite cookies. Rate limit and lockout on login, OTP and reset endpoints. Strong password policy and breached-password check. Admin: mandatory TOTP 2FA. Generic error messages ("email or password incorrect"). |
| **A08 Software and Data Integrity Failures** | Signed webhook verification. CI/CD pipeline protected (reviewed PRs, protected main branch, pinned action versions). Signed container images. No unsafe deserialisation. Subresource integrity for any third-party script. |
| **A09 Logging and Monitoring Failures** | Structured logs with correlation IDs. Log logins, failures, permission denials, admin actions, payment events. Never log passwords, tokens, card or full personal data. Alerts on spikes (failed logins, 5xx, webhook failures). |
| **A10 Server-Side Request Forgery** | No user-supplied URLs fetched by the server. If image-by-URL import is added, use allow-listed hosts and block private IP ranges. |

### 8.1 Additional measures
- **CSRF:** SameSite cookies + CSRF token for cookie-authenticated state-changing requests.
- **XSS:** React escaping, no `dangerouslySetInnerHTML` without sanitiser, strict CSP.
- **Rate limiting:** per IP and per user at gateway; tighter on auth, OTP, checkout, search.
- **Bot protection:** CAPTCHA (privacy-friendly) on register, login after failures, and guest checkout.
- **File upload:** type allow-list (JPEG, PNG, WebP), size limit, magic-byte check, re-encode images, store outside web root, random file names, virus scan if possible.
- **Service-to-service auth:** mTLS or signed internal tokens; internal services not publicly reachable.
- **Database:** least-privilege DB user per service; no shared credentials.
- **Backups:** daily encrypted backups, restore tested monthly.
- **Privacy:** collect minimum data; privacy policy; data export/delete on request (India DPDP Act readiness).
- **Pre-launch:** run OWASP ZAP scan, dependency scan, and a manual penetration test of auth, checkout, and admin.

### 8.2 Security test cases (must pass before launch)
1. Customer A cannot open Customer B's order by changing the ID.
2. Customer cannot call any admin endpoint, even with a forged role claim.
3. Changing price or quantity (negative, huge, decimal) in the request is rejected or ignored.
4. Replaying a payment webhook does not duplicate effects; a forged webhook is rejected.
5. 100 rapid login attempts trigger throttling and lockout.
6. SQL injection and XSS payloads in search, name, address fields are neutralised.
7. Uploading a `.php` or oversized file is rejected.
8. Expired or revoked refresh token cannot get a new access token.

---

## 9. Design System

### 9.1 Design direction
Hira should feel like a **trusted neighbourhood shop that went online**, not a tech template. Calm, clear, photography-first, easy to read on a phone in bright sunlight. The product images are the stars; the interface stays quiet around them.

**Avoid:** purple-to-blue gradients, neon glows, glassmorphism everywhere, identical rounded cards with the same grey shadow, all-caps labels on everything, decorative emoji, stock "AI" sparkle icons.

### 9.2 Colour palette
Chosen for warmth and trust, with strong contrast. Verify every pair meets **WCAG AA (4.5:1 for text)** before finalising.

| Token | Name | Hex | Use |
|---|---|---|---|
| `--hira-primary` | Peacock | `#0F5C6E` | Primary buttons, links, header |
| `--hira-primary-dark` | Deep peacock | `#0A4452` | Hover/pressed |
| `--hira-accent` | Marigold | `#E8A317` | Highlights, offers, rating stars (use dark text on it) |
| `--hira-bg` | Chalk | `#F6F7F5` | Page background |
| `--hira-surface` | White | `#FFFFFF` | Cards, sheets, forms |
| `--hira-text` | Slate | `#22303C` | Main text |
| `--hira-text-muted` | Stone | `#5E6B75` | Secondary text |
| `--hira-border` | Mist | `#DCE1E4` | Dividers, input borders |
| `--hira-success` | Leaf | `#2E7D4F` | In stock, delivered |
| `--hira-warning` | Amber clay | `#B86E00` | Low stock, pending |
| `--hira-danger` | Chilli | `#B93A2E` | Errors, out of stock, cancel |

Rules: one primary action colour per screen; Marigold is for emphasis only; never use colour alone to show status (pair with text or icon).

### 9.3 Typography
- Headings: **Bricolage Grotesque** (friendly, distinctive); Body/UI: **Figtree**.
- **Tamil support:** fall back to **Noto Sans Tamil** so Tamil text renders properly on every device.
- Font stack always ends with `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.
- Scale: 14 / 16 / 18 / 22 / 28 / 36 px; body 16px minimum; line-height 1.5 body, 1.2 headings; line length under 75 characters.
- Sentence case everywhere. Price is bold with ₹ and Indian digit grouping (₹1,24,999).

### 9.4 Layout, spacing, shape
- 4px base spacing grid (4, 8, 12, 16, 24, 32, 48).
- Corner radius: small 6px (inputs, tags), medium 10px (cards), none/large only where meaningful. Do not apply one radius to everything.
- Shadows used sparingly; prefer borders for separation.
- Touch targets at least **44×44 px**.
- Motion: only in response to user actions (add to cart feedback, drawer open); respect `prefers-reduced-motion`.

### 9.5 Responsive behaviour
| Breakpoint | Width | Layout |
|---|---|---|
| Mobile | 320–599 px | Single column; product grid 2 columns; bottom nav (Home, Categories, Cart, Account); sticky "Add to cart" bar on product page; filters in a bottom sheet |
| Tablet | 600–1023 px | Grid 3 columns; side filter drawer; admin panel with collapsible sidebar |
| Desktop | ≥ 1024 px | Grid 4 columns; persistent filters; top navigation; admin fixed sidebar |

Design **mobile first**; test also at 320 px, 768 px (iPad portrait), 1024 px, 1440 px, and landscape.

### 9.6 iPhone / Safari compatibility rules
- Use `100dvh` (with `100vh` fallback) for full-height layouts; avoid fixed-height tricks that break with Safari's collapsing toolbar.
- Respect notch and home bar: `viewport-fit=cover` + `env(safe-area-inset-*)` padding on sticky bars and bottom nav.
- Inputs use **font-size ≥ 16px** to prevent iOS auto-zoom.
- Add `-webkit-` prefixes via Autoprefixer; avoid unsupported CSS without fallback (check caniuse).
- Use `inputmode`, `autocomplete`, and correct `type` attributes (`tel`, `email`) for good mobile keyboards and autofill.
- Do not depend on hover; every hover feature has a tap equivalent.
- Test sticky positioning, date pickers, file upload (camera/gallery), and scroll lock for modals on real iOS devices.
- Payment: use gateway flows tested on iOS Safari (UPI intent behaves differently on iPhone; keep a card/netbanking fallback).
- PWA basics: manifest, icons, theme colour; optional install prompt.

### 9.7 Accessibility floor
Keyboard navigable, visible focus ring (2px Peacock with offset), semantic HTML, labels on all inputs, alt text on product images, error messages next to fields, contrast AA, screen reader tested for checkout.

### 9.8 Writing style (UI copy)
Plain, specific, active. Buttons say what happens: "Add to cart", "Place order", "Save address". Errors explain the fix: "Only 2 left. Reduce quantity to continue." Empty states invite action: "Your cart is empty. Browse today's products."

---

## 10. Screens

### Customer app
1. Home (categories, featured, new arrivals)
2. Product listing (search, filters, sort, pagination or infinite scroll)
3. Product detail (gallery, price, stock state, description, add to cart, share)
4. Cart (quantity change, stock warnings, price summary)
5. Checkout (address, delivery, payment, review)
6. Order success and payment failure/retry
7. My orders, order detail with tracking timeline, cancel/return
8. Account (profile, addresses, change password, logout all devices)
9. Login, register, forgot/reset password, OTP
10. Static pages: About, Contact, Shipping, Returns, Privacy, Terms

### Admin app (separate URL: admin.hira…)
1. Login with 2FA
2. Dashboard: orders needing action, today's sales, low-stock and out-of-stock lists
3. Orders list (filters by status/date/search) and order detail with action buttons
4. Products list (stock badge, quick toggle Available/Unavailable)
5. Add/edit product with image upload
6. Inventory: restock form, stock history, low-stock alerts
7. Returns and refunds
8. Categories
9. Customers (read-only)
10. Audit log and settings (shipping fee, COD limit, low-stock threshold, store details)

---

## 11. API Conventions (all services)

- REST + JSON, versioned: `/api/v1/...`; OpenAPI (Swagger) spec per service.
- Auth: `Authorization: Bearer <access token>` or secure cookie.
- Standard error body: `{ "code": "OUT_OF_STOCK", "message": "...", "details": {...}, "correlationId": "..." }`.
- Pagination: `?page=1&limit=20` (max limit 100).
- Idempotency: `Idempotency-Key` header on `POST /orders` and payment creation.
- Validation at the edge of every service.

### Key endpoints (summary)
| Service | Endpoint | Role |
|---|---|---|
| auth | `POST /auth/register`, `/login`, `/refresh`, `/logout`, `/forgot-password`, `/reset-password` | public |
| auth | `GET/PUT /me`, `/me/addresses` | customer |
| catalog | `GET /products`, `/products/:slug`, `/categories` | public |
| catalog | `POST/PUT/DELETE /admin/products`, `PATCH /admin/products/:id/availability` | admin |
| inventory | `GET /inventory/:productId` (internal), `POST /admin/inventory/:id/restock`, `POST /admin/inventory/:id/adjust` | admin |
| cart | `GET/POST/PATCH/DELETE /cart/items` | customer/guest |
| order | `POST /orders`, `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel`, `POST /orders/:id/return` | customer |
| order | `GET /admin/orders`, `POST /admin/orders/:id/process`, `/ship`, `/deliver`, `/cancel` | admin |
| payment | `POST /payments/create`, `POST /webhooks/razorpay` | customer / gateway |

---

## 12. Repository and Module Structure

Monorepo (recommended for small team) with independent deployable services.

```
hira/
├── apps/
│   ├── web/                 # customer Next.js app
│   └── admin/               # admin React app
├── services/
│   ├── api-gateway/
│   ├── auth-service/
│   ├── catalog-service/
│   ├── inventory-service/
│   ├── cart-service/
│   ├── order-service/
│   ├── payment-service/
│   └── notification-service/
├── packages/
│   ├── ui/                  # shared components and design tokens
│   ├── types/               # shared TypeScript types and event contracts
│   └── config/              # eslint, tsconfig, prettier
├── infra/
│   ├── docker/              # compose files for local dev
│   ├── k8s/                 # manifests / helm charts
│   └── ci/                  # pipeline definitions
├── docs/                    # ADRs, API specs, runbooks
└── HIRA_PROJECT_SPEC.md
```

Inside each service (NestJS style):
```
src/
├── modules/<feature>/ (controller, service, dto, entity, repository, tests)
├── common/ (guards, filters, interceptors, logger)
├── events/ (publishers, consumers)
└── main.ts
```

### Event contracts (examples)
`order.created`, `order.confirmed`, `order.shipped`, `order.delivered`, `order.cancelled`, `payment.succeeded`, `payment.failed`, `refund.completed`, `stock.reserved`, `stock.released`, `stock.low`, `stock.out`, `product.availability_changed`.

---

## 13. Quality, Testing, Observability

- **Unit tests** for business rules (stock math, state machine, price calculation) with 80%+ coverage on these.
- **Integration tests** per service with a real Postgres (Testcontainers).
- **Contract tests** for service-to-service APIs and events.
- **Concurrency test:** 50 parallel buyers for 5 pieces → exactly 5 succeed, stock never negative.
- **E2E tests** (Playwright) on Chromium, Firefox, WebKit (Safari engine), plus mobile emulation for iPhone and Android.
- **Real-device pass:** at least one iPhone, one Android, one iPad before launch.
- **Performance:** Lighthouse mobile score target ≥ 90 for performance, accessibility, best practices; LCP under 2.5 s on 4G.
- **Observability:** metrics, logs, traces, uptime checks, alerts for payment failures and stuck orders.

---

## 14. Deployment

- Environments: local → staging → production; staging mirrors production.
- Config via environment variables, secrets via a secrets manager.
- Database migrations versioned and automatic in pipeline (backward-compatible).
- Zero-downtime rolling deploys; health checks gate traffic.
- CDN for images and static assets; gzip/brotli; HTTP/2.
- Daily backups, tested restore, documented rollback.

---

## 15. Non-Functional Targets

| Area | Target |
|---|---|
| Availability | 99.5%+ |
| API response (p95) | < 300 ms for reads, < 800 ms for checkout |
| Page load (4G mobile) | LCP < 2.5 s |
| Data durability | No order or payment record loss; RPO ≤ 24 h (aim lower) |
| Scalability | Handles sale-day spikes via caching, queues, horizontal scaling |

---

## 16. Open Decisions (to confirm with the owner)

1. Payment gateway: Razorpay (suggested) or another? COD allowed?
2. Guest checkout: yes or no?
3. Delivery: own delivery or courier (Shiprocket, Delhivery)? Shipping fee rules?
4. Product variants (size/colour) needed from day one?
5. Languages: English only, or English + Tamil in the UI?
6. GST invoicing: needed from launch?
7. Notifications: email only, or SMS/WhatsApp as well?
8. Hosting provider and monthly budget?
9. Coupons, wishlists and reviews: launch or later?

---

## 17. Build Order and Milestones (module by module)

| Phase | Module | Deliverable |
|---|---|---|
| 0 | Foundation | Repo, Docker Compose, CI, design tokens, shared UI, logging, gateway skeleton |
| 1 | **auth-service** + login screens | Register/login/refresh, roles, admin 2FA, rate limits |
| 2 | **catalog-service** + admin product screens + customer listing/detail | CSV import of 50 products, image upload, availability toggle |
| 3 | **inventory-service** | Stock, restock, low/out-of-stock states, movement log, concurrency tests |
| 4 | **cart-service** | Guest + user cart, validation against stock/price |
| 5 | **order-service** | State machine, checkout saga, admin order screens |
| 6 | **payment-service** | Gateway integration, webhooks, refunds, COD |
| 7 | **notification-service** | Order emails/SMS, low-stock alert to admin |
| 8 | Hardening | OWASP ZAP, pen-test fixes, load test, accessibility and real-device testing |
| 9 | Launch | Staging sign-off, production deploy, monitoring, backup drill |

**Definition of done for every module:** code reviewed, tests passing, security checklist (Section 8) applied, API documented, responsive on mobile/tablet/desktop, and tested in Chrome, Safari (including iPhone), Firefox, Edge.

---

## 18. Quick Rules for Whoever Builds This

1. Never trust the client: recalculate price, stock and totals on the server.
2. Only inventory-service changes stock, and only through atomic operations.
3. Orders change status only through the state machine, and every change is logged.
4. Payment is confirmed only by a verified webhook.
5. Every endpoint has authentication, authorisation, validation and rate limiting.
6. Money is integer paise; time is UTC.
7. Nothing is hard-deleted; everything important is audited.
8. Mobile first; test on a real iPhone.
9. Use the Hira palette and type tokens only; no ad-hoc colours.
10. Build one module at a time and finish its tests before moving on.

