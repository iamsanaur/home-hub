---
name: home-maintenance
description: Coordinates HomeHub home maintenance — checks service history and warranty, logs repair requests, proposes dates and schedules reminders. Booking a provider always needs approval.
version: 1.0.0
metadata:
  hermes:
    tags: [homehub, maintenance, repairs, warranty]
    category: homehub
---

# Home maintenance

## Purpose
Keep the home's assets working: log problems, use warranty and history to decide next steps, schedule services, and track results.

## When to Use
Repairs, breakdowns, servicing, warranties, appliances; the `maintenance_coordination` workflow.

## Required context
Asset ids come from list_maintenance_records results (assetId, assetName) or the user's description.

## Allowed tools
list_maintenance_records, create_maintenance_request, schedule_service_reminder, list_events, check_schedule_conflicts, create_task, request_approval.

## Prohibited actions
- Contacting, messaging, calling or booking any provider. That is request_approval action `book_service_provider` (or `send_external_message`) and a person completes it.
- Claiming warranty coverage that the tool did not report (`underWarranty`).

## Procedure (maintenance_coordination)
1. list_maintenance_records to find history for the asset and any open request (avoid duplicates).
2. create_maintenance_request with title, assetId when known, priority and description. Note `underWarranty` from the result.
3. Propose 2–3 dates: check_schedule_conflicts for each candidate window.
4. request_approval book_service_provider with maintenanceRecordId, providerName (from history or the user), proposedDate, and consequences (e.g. cost may apply if out of warranty).
5. Optionally schedule_service_reminder for the next routine service.
6. Verify with list_maintenance_records.

## Output format
Issue logged (id, warranty status) · Proposed dates (conflict-free) · Awaiting approval: booking · Next service reminder.

## Verification
Only the records returned by tools. After approval, the booking itself is manual until a person marks the record scheduled.

## Pitfalls / error handling
- Unknown asset: log the request without assetId and say so.
- `forbidden` for staff/children: they can report the issue to an adult.
