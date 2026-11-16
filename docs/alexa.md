# Alexa

Status: **implemented and tested with mocked Alexa requests; awaiting Amazon developer credentials.** Nothing on this page has been exercised against Amazon's live services yet.

HomeHub is one multi-capability Alexa skill with two parts:

| Part | What people say | Path | Endpoint |
|---|---|---|---|
| Smart Home | "Alexa, turn on the living room lamp" | Alexa → AWS Lambda forwarder → `alexa/smart-home` | Lambda (required by Amazon for Smart Home) |
| Custom voice intents | "Alexa, ask Home Hub what's on the shopping list" | Alexa → `alexa/skill` | HTTPS, Amazon-signed |

Both parts share one account link, with OAuth 2.0 authorization-code grant served by HomeHub.

## Safety model

- **Only what you share.** Discovery returns only devices with `alexa.exposed = true` whose room isn't hidden. New devices start hidden. Managers toggle this in **Channels → Alexa** or on a device.
- **Voice never unlocks.** `LockController.Unlock` always returns `NOT_SUPPORTED_IN_CURRENT_MODE` and is audited as denied. Locking is allowed.
- **Approvals stay in the app.** Any action needing approval or confirmation is answered with `NOT_SUPPORTED_IN_CURRENT_MODE` ("This needs approval in the HomeHub app").
- **Verified state only.** HomeHub replies `Response` only after the device state has been read back and matches. If it doesn't match, it replies `ENDPOINT_UNREACHABLE`. A device not seen for over an hour reports `UNREACHABLE`.
- **Adults only.** Linking needs an owner, admin or adult membership. Every request re-checks membership, so removing someone or demoting them to child or staff cuts Alexa off immediately (`INSUFFICIENT_PERMISSIONS`).
- **Household isolation.** Tokens are bound to one member and one household. Endpoint IDs from other households come back as `NO_SUCH_ENDPOINT`.
- **No finance by voice.** Spoken briefings leave out bills and amounts.
- **No recordings.** HomeHub never receives audio. It stores only the intent or directive name, time and result (`auditEvents`, channel `alexa`).

## Capability mapping

| HomeHub capability | Alexa interface | Directives | Notes |
|---|---|---|---|
| `power` | `Alexa.PowerController` | TurnOn, TurnOff | |
| `brightness` | `Alexa.BrightnessController` | SetBrightness, AdjustBrightness | 0–100, clamped |
| `thermostat` | `Alexa.ThermostatController` | SetTargetTemperature, AdjustTargetTemperature, SetThermostatMode | 16–30 °C, else `TEMPERATURE_VALUE_OUT_OF_RANGE`. °F and K are converted |
| `lock` | `Alexa.LockController` | Lock | **Unlock refused** |
| `contact` | `Alexa.ContactSensor` | ReportState | |
| `motion` | `Alexa.MotionSensor` | ReportState | |
| `temperature` | `Alexa.TemperatureSensor` | ReportState | °C |
| any | `Alexa.EndpointHealth` | ReportState | connectivity from reachability plus last-seen time |
| `humidity` | — | — | not exposed (no matching interface mapped yet) |

Display categories: light → `LIGHT`, plug → `SMARTPLUG`, thermostat/ac → `THERMOSTAT`, lock → `SMARTLOCK`, and sensors → their sensor categories. Simulated devices show the manufacturer "HomeHub (simulated)".

**Proactive state.** `AcceptGrant` exchanges the grant code with Login with Amazon and keeps the Event Gateway tokens in Secret Manager. After that, device changes made in the app, by automations or physically send a `ChangeReport`. Changes Alexa itself requested aren't re-reported, because the directive response already carries them.

## Custom intents

| Intent | Example | Behaviour |
|---|---|---|
| `ShoppingListIntent` | "what's on the shopping list" | Reads up to 6 unpurchased items from the most recently updated list |
| `AddShoppingItemIntent` | "add eggs" | Asks to confirm (`Dialog.ConfirmIntent`) before writing. Merges with an existing line |
| `ChoresIntent` | "what are my chores" | Your tasks due today, as your role permits |
| `DinnerIntent` | "what's for dinner" | Tonight's dinner from the meal plan |
| `BriefingIntent` | "give me my briefing" | Deterministic briefing **without finance** |
| `DoorLockedIntent` | "is the front door locked" | State of locks shared with Alexa. Says so when a lock can't be reached |

The intents make no model calls; every answer comes straight from Firestore. If the account isn't linked, Alexa sends a `LinkAccount` card.

## Request authentication

| Endpoint | Credential | Check |
|---|---|---|
| `GET/POST /oauth/authorize` | Firebase email/password, then consent | Exact registered redirect URI (never redirected otherwise), single-use session (5 min), single-use code (5 min) |
| `POST /oauth/token` | Client ID + secret (Basic or body) | Codes single-use. Refresh tokens rotate, and **reusing one revokes the whole link**. Access tokens last 1 h, refresh tokens 180 d. All stored only as SHA-256 hashes |
| `POST /smart-home` | `X-HomeHub-Forwarder-Signature` = HMAC-SHA256(secret, `${ts}.${body}`) | ±300 s window, timing-safe compare, then Alexa bearer token |
| `POST /skill` | Amazon request signature | Cert URL (https, `s3.amazonaws.com`, `/echo.api/`, port 443), chain to a trusted root, SAN `echo-api.amazon.com`, `Signature-256` over the raw body, timestamp ±150 s, skill ID |

## Setup (once you have an Amazon developer account)

1. **Create the skill** in the Alexa developer console as a Smart Home skill. Add the custom model from `backend/alexa/skill-package/` (multi-capability). Check the manifest fields against the current ASK schema; `skill.json` is a template.
2. **Account linking** (Authorization Code Grant):
   - Authorization URI: `https://<region>-<project>.cloudfunctions.net/alexa/oauth/authorize`
   - Access token URI: `https://<region>-<project>.cloudfunctions.net/alexa/oauth/token`
   - Client ID: the value of `ALEXA_OAUTH_CLIENT_ID`. Client secret: a long random value that you also set as the `ALEXA_OAUTH_CLIENT_SECRET` secret.
   - Authentication scheme: HTTP Basic. Scope: `homehub`.
   - Copy the console's **Alexa redirect URLs** into `ALEXA_REDIRECT_URIS`, comma-separated.
3. **Permissions:** enable *Send Alexa Events*. Put the skill's LWA client ID in `LWA_CLIENT_ID` and its secret in the `LWA_CLIENT_SECRET` secret.
4. **Lambda forwarder** (`backend/alexa/lambda`):
   - Create a Node.js 22 Lambda from `npm run zip` and add an *Alexa Smart Home* trigger with your skill ID.
   - Set `HOMEHUB_SMART_HOME_URL` and `FORWARDER_SECRET` on it, using the same value as the `ALEXA_FORWARDER_SECRET` Firebase secret.
   - Deploy it in the region your skill's locale requires (`eu-west-1` for en-IN, `us-east-1` for en-US).
5. **Custom endpoint:** `https://<region>-<project>.cloudfunctions.net/alexa/skill`, certificate type "wildcard". Put the skill ID in `ALEXA_SKILL_ID`.
6. **Functions environment:** put the plain (non-secret) values in `backend/firebase/functions/.env.<project>`, which is git-ignored. Set the secrets with `firebase functions:secrets:set`, then deploy.
7. **Test:** link from the Alexa app, run discovery, then try each directive and intent in the developer console simulator.

When `ALEXA_SKILL_ID` and `ALEXA_OAUTH_CLIENT_ID` are set, the catalog changes Alexa from `needs_platform_credentials` to available, and **Channels** shows it as linkable.

## Certification checklist

- [ ] Privacy policy and terms URLs are live (placeholders in `skill.json`)
- [ ] Icons (108 px and 512 px) from `assets/branding/`
- [ ] A test account with demo devices exposed is in the testing instructions
- [ ] Discovery returns only exposed devices; friendly names are unique
- [ ] Every directive answers within 8 s (forwarder timeout is 7 s)
- [ ] `ReportState` works for every discovered endpoint
- [ ] `AcceptGrant` succeeds and a `ChangeReport` arrives after an app-side change
- [ ] Unlinking in the Alexa app, or **Disconnect** in HomeHub, stops all access
- [ ] Error responses use the documented types (`NO_SUCH_ENDPOINT`, `ENDPOINT_UNREACHABLE`, `INVALID_AUTHORIZATION_CREDENTIAL`, `EXPIRED_AUTHORIZATION_CREDENTIAL`, `INSUFFICIENT_PERMISSIONS`, `TEMPERATURE_VALUE_OUT_OF_RANGE`, `NOT_SUPPORTED_IN_CURRENT_MODE`)
- [ ] Custom skill: help, stop and cancel work; shouldEndSession is correct; no finance read aloud

## Tests

- `functions/test/unit/phase1.test.ts`: request-signature verification against a generated certificate chain, certificate URL rules, and the state-to-property mapping.
- `functions/test/integration/phase1.test.ts` (Firebase emulators):
  - the full OAuth flow, including bad redirect, wrong password, refresh rotation and reuse revocation;
  - Smart Home discovery, exposure, verified power, voice unlock refused, room hiding, cross-household `NO_SUCH_ENDPOINT`, thermostat range and ReportState;
  - forwarder HMAC;
  - AcceptGrant and ChangeReport, with Amazon endpoints mocked;
  - custom intents: link card, confirm-before-add, briefing without finance.
- `backend/alexa/lambda/test.mjs`: forwarder signing and error responses.
