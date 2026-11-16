# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

Two independent native clients sharing one design language and backend contract:
- iOS — Swift/SwiftUI, minimum iOS 26 (native Liquid Glass APIs on every supported device).
- Android — Kotlin/Jetpack Compose, minimum API 26; real backdrop blur on API 31+, tinted translucent fallback below.

## Stack

Fixed by the brief (`claude.md`): native Kotlin/Compose and Swift/SwiftUI, Firebase backend, Hermes Agent runtime behind a HomeHub API gateway and MCP server. No web app, no cross-platform UI.

## Users

Households anywhere in the world (confirmed: global, not India-first). A household has an owner, administrators, adults, children and optionally domestic staff. Members coordinate chores, food, money, bills, home maintenance and family schedules, usually on a phone in short sessions between other things. Currency, locale and timezone are chosen per household at onboarding; INR/UPI is one supported configuration among many.

## Product Purpose

HomeHub AI is an agentic household manager: one place for the operational life of a home, plus an AI coordinator (Hermes) that can plan and carry out routine household work on the family's behalf under explicit permissions and approvals. Success means the household spends less effort on coordination and nothing consequential happens without a human knowing and, where required, approving.

## Positioning

Agentic, not just a list app: the AI acts through narrowly scoped, audited household tools with server-enforced approvals, an emergency pause and measurable token cost. Ordinary operations are deterministic and work fully without the AI.

## Operating Context

- Quick daily check-ins (today's tasks, bills, shopping) and occasional planning sessions (weekly meals, budgets, guests).
- Shared use across family members and staff with different permissions; staff see only assigned work.
- Intermittent connectivity: tasks, shopping lists and notes must work offline.
- Money is recorded in integer minor units with an ISO 4217 currency code.

## Capabilities and Constraints

See `claude.md` §4 for the fifteen modules. Approval is mandatory for purchases, bookings, payments, external messages, sharing sensitive data, deleting important documents and irreversible actions. The AI never moves money.

## Brand Commitments

- Name: **HomeHub AI** — tagline *Your Agentic Household Manager*.
- Logo: `brand-logo.png` (house with family and window, orbit swoosh, sparkle; emerald/sage on warm ivory, gold window).
- Personality: warm, composed, capable, discreet, optimistic. Never childish, clinical, robotic or gamified.
- `design.md` is the authoritative visual specification (Liquid Glass on both platforms, palette, type scale).

## Evidence on Hand

Only the brand logo. No testimonials, customer data, benchmarks or pricing exist; none may be fabricated. Seed data is clearly local development sample data.

## Product Principles

1. Human control over agent action: suggestions, pending approvals, running work and verified outcomes are always distinguishable.
2. Deterministic first: the app is fully useful when the AI is unavailable.
3. Privacy by role: each member sees only what their role needs.
4. Calm over clutter: surface what matters now.

## Accessibility & Inclusion

WCAG 2.2 AA as benchmark; Dynamic Type / font scaling, screen readers, reduced motion and reduced transparency on both platforms; RTL readiness and long-translation (e.g. Hindi) expansion.
