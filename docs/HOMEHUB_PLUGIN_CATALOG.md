# HomeHub AI — Plugin & Integration Catalogue

This is the product roadmap and marketplace taxonomy for HomeHub AI. A listed service is a **planned connector target**, not proof of a working integration. Availability depends on official APIs, partner approval, device region, account type and vendor terms. The app must show accurate live connection states.

## Architecture

HomeHub uses one secured Gateway, one primary Hermes orchestrator, on-demand specialist skills/agents, and a versioned plugin framework. Plugins expose typed, permission-scoped tools; skills provide workflows; channels provide user access; device adapters provide smart-home capabilities.

## Marketplace categories

| Category | Initial connector targets |
|---|---|
| Smart-home hubs/protocols | Home Assistant, Matter, Thread, Zigbee, Z-Wave, MQTT |
| Voice assistants | Amazon Alexa, HomeHub Voice, Siri Shortcuts/App Intents, Google Assistant/Gemini where public APIs permit |
| Smart-home brands | Philips Hue, IKEA DIRIGERA, Aqara, Tuya/Smart Life, Shelly, SwitchBot, TP-Link Kasa/Tapo, Xiaomi, SmartThings, Ecobee, Nest/Google, Ring, Eufy |
| Appliances & devices | ACs, fans, lights, plugs, switches, sensors, locks, curtains, thermostats, robot vacuums, cameras, doorbells, energy meters, leak/smoke/CO sensors |
| Audio & media | Sonos and supported multi-room audio platforms |
| Messaging | WhatsApp Business Platform, Telegram, Discord, Slack, Microsoft Teams, Google Chat, email, supported SMS providers |
| Calendars & tasks | Google Calendar, Outlook Calendar, Google Tasks, Microsoft To Do, Todoist |
| Files & notes | Google Drive, OneDrive, Dropbox, Notion |
| Family & school | Shared calendars, school calendar feeds, parent portals through official integrations |
| India finance & bills | Account Aggregator ecosystem via compliant partners, utility billers, recharge providers, statement import, UPI intent/deep links |
| Shopping & groceries | Amazon India, Flipkart, BigBasket, Blinkit, Zepto, Swiggy Instamart, Swiggy, Zomato (official/partner access only) |
| Home services | Supported service-booking platforms, utility providers, appliance warranty/service portals |
| Search & information | Brave, Google/Bing search APIs where available, Perplexity and other approved providers |

| Speech & transcription | Platform speech APIs, Google, Azure, Deepgram, ElevenLabs, OpenAI speech/realtime APIs |
| Developer/custom | Authenticated MCP servers, signed webhooks, REST connector builder, calendar/feed imports, HomeHub Plugin SDK |

## Alexa — first-class integration

1. **Alexa Smart Home Skill:** account linking, endpoint discovery, supported capability interfaces, state reporting, device reachability and secure unlink.
2. **HomeHub Custom Skill:** household briefing, shopping list, chores, dinner plan, bill/reminder summaries and safe list updates.
3. **Per-room/device exposure:** household owner chooses what Alexa can discover and control.
4. **Privacy:** no raw audio retention; no sensitive spoken disclosures by default; voice recognition is not treated as strong authentication.
5. **Safety:** no purchase, payment, unlock, alarm-disarm or other high-risk action from ambiguous voice requests. Require explicit approval or direct the user to the app.
6. **Failure handling:** never announce success without verified integration/device confirmation.

## Plugin lifecycle and states

`Discovered -> Available -> Needs setup -> Connecting -> Connected -> Action required / Error -> Paused / Disconnected`

Every plugin declares publisher, version, region, auth method, scopes, data categories, tools, risk levels, event subscriptions, network destinations, lifecycle hooks, privacy policy and compatibility range.

## Trust tiers

- **First-party:** maintained by HomeHub.
- **Verified partner:** official vendor API or approved partner integration, tested by HomeHub.
- **Supported bridge:** documented protocol or local hub (e.g. Home Assistant, Matter).
- **Community:** reviewed but not guaranteed by HomeHub.
- **Custom:** user-configured webhook/MCP connector with explicit trust warnings.

## Non-negotiable safeguards

- Least privilege; no direct unrestricted Firestore access.
- OAuth/API secrets stored in Secret Manager; never in client apps, Firestore documents or logs.
- Schema validation, signed webhooks, replay protection, idempotency, rate limits and audit.
- Approval gates for purchases, payments, external messages/bookings, destructive actions, sensitive data sharing and high-risk physical device actions.
- Finance integrations default to read-only; no silent transfers or UPI payments.
- Never scrape private APIs, bypass MFA or violate vendor terms.
- No plugin is marked live until implemented, tested and region-checked.
- Per-plugin pause/revoke and global emergency pause.
- Firebase Emulator Suite tests for tenant isolation and policy enforcement.

## Suggested rollout

1. Gateway, plugin manifest/registry, permissions, audit and sample plugin.
2. Home Assistant + Matter bridge, app voice, notifications, calendar and email read-only.
3. Alexa Smart Home Skill + Custom Skill.
4. India-first bills, finance read-only, groceries/shopping and home maintenance.
5. Broader partner/community catalogue and plugin SDK.

See `HOMEHUB_MASTER_PROMPT_OPENCLAW_ALEXA_FIREBASE_NATIVE.md` for full implementation requirements and `design.md` for UI/design authority.
