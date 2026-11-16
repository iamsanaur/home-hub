#!/usr/bin/env node
// Tiny Google API helper for the setup wizard. It reuses the login the Firebase CLI already holds (no extra sign-in,
// nothing stored): it mints a short-lived access token from the CLI's refresh token and calls a few Google APIs.
//
//   node scripts/lib/gcp.mjs billing-status <project>        -> prints "enabled" | "disabled"
//   node scripts/lib/gcp.mjs billing-accounts                -> prints "<id>\t<name>" for each open billing account
//   node scripts/lib/gcp.mjs billing-link <project> <acct>   -> links the project to a billing account
//   node scripts/lib/gcp.mjs enable-apis <project>           -> enables the Google APIs HomeHub needs
//   node scripts/lib/gcp.mjs auth-email <project>            -> turns on Firebase Auth with email/password sign-in
//   node scripts/lib/gcp.mjs storage-bucket <project>        -> creates the default Cloud Storage bucket if missing
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REGION = "asia-south1";
const die = (m) => { console.error(m); process.exit(1); };

// The Firebase CLI's own OAuth client. These two values are public: they ship in the open-source firebase-tools
// package (src/api.ts) and identify the CLI, not you. Override with FIREBASE_CLIENT_ID / FIREBASE_CLIENT_SECRET if they ever change.
const CLI_CLIENT = {
  id: process.env.FIREBASE_CLIENT_ID ?? "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com",
  sec: process.env.FIREBASE_CLIENT_SECRET ?? "j9iVZfS8kkCEFUPaAeJV0sAi",
};
const cliClient = () => CLI_CLIENT;

async function token() {
  const cfgPath = join(homedir(), ".config", "configstore", "firebase-tools.json");
  if (!existsSync(cfgPath)) die("Not signed in to the Firebase CLI. Run: firebase login");
  const refresh = JSON.parse(readFileSync(cfgPath, "utf8"))?.tokens?.refresh_token;
  if (!refresh) die("No Firebase CLI login found. Run: firebase login");
  const c = cliClient();
  if (!c) die("Could not find the Firebase CLI's files. Install it with: npm install -g firebase-tools");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refresh, client_id: c.id, client_secret: c.sec, grant_type: "refresh_token" }) });
  const j = await r.json();
  if (!j.access_token) die("Could not refresh your Firebase login. Run: firebase login --reauth");
  return j.access_token;
}

async function call(tok, method, url, body, project) {
  const r = await fetch(url, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", ...(project ? { "x-goog-user-project": project } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { ok: r.ok, status: r.status, json };
}
const msg = (r) => r.json?.error?.message ?? JSON.stringify(r.json).slice(0, 300);
const poll = async (tok, url, tries = 60) => { for (let i = 0; i < tries; i++) { const r = await call(tok, "GET", url); if (r.json?.done) return r; await new Promise((s) => setTimeout(s, 3000)); } return null; };

const [cmd, a, b] = process.argv.slice(2);
const tok = await token();

if (cmd === "billing-status") {
  const r = await call(tok, "GET", `https://cloudbilling.googleapis.com/v1/projects/${a}/billingInfo`);
  if (!r.ok) die(`Could not read billing for ${a}: ${msg(r)}`);
  console.log(r.json.billingEnabled ? "enabled" : "disabled");
} else if (cmd === "billing-accounts") {
  const r = await call(tok, "GET", "https://cloudbilling.googleapis.com/v1/billingAccounts");
  if (!r.ok) die(`Could not list billing accounts: ${msg(r)}`);
  for (const x of r.json.billingAccounts ?? []) if (x.open) console.log(`${x.name.replace("billingAccounts/", "")}\t${x.displayName}`);
} else if (cmd === "billing-link") {
  const r = await call(tok, "PUT", `https://cloudbilling.googleapis.com/v1/projects/${a}/billingInfo`, { billingAccountName: `billingAccounts/${b}` });
  if (!r.ok) die(`Could not link billing: ${msg(r)}`);
  console.log("linked");
} else if (cmd === "enable-apis") {
  const services = ["firestore", "cloudfunctions", "cloudbuild", "artifactregistry", "run", "secretmanager", "eventarc", "pubsub", "cloudscheduler",
    "identitytoolkit", "firebasestorage", "storage", "fcm", "firebaseappcheck", "firebaserules", "firebase"].map((s) => `${s}.googleapis.com`);
  const r = await call(tok, "POST", `https://serviceusage.googleapis.com/v1/projects/${a}/services:batchEnable`, { serviceIds: services }, a);
  if (!r.ok) die(`Could not enable APIs: ${msg(r)}`);
  if (r.json?.name) await poll(tok, `https://serviceusage.googleapis.com/v1/${r.json.name}`);
  console.log("enabled");
} else if (cmd === "auth-email") {
  // Initialise Firebase Authentication (idempotent), then switch on email/password.
  const init = await call(tok, "POST", `https://identitytoolkit.googleapis.com/v2/projects/${a}/identityPlatform:initializeAuth`, {}, a);
  if (!init.ok && !/already|ALREADY/.test(msg(init))) die(`Could not initialise Authentication: ${msg(init)}`);
  const r = await call(tok, "PATCH", `https://identitytoolkit.googleapis.com/admin/v2/projects/${a}/config?updateMask=signIn.email`, { signIn: { email: { enabled: true, passwordRequired: true } } }, a);
  if (!r.ok) die(`Could not enable email sign-in: ${msg(r)}`);
  console.log("enabled");
} else if (cmd === "storage-bucket") {
  const have = await call(tok, "GET", `https://firebasestorage.googleapis.com/v1beta/projects/${a}/defaultBucket`, undefined, a);
  if (have.ok) { console.log(`exists ${have.json.name ?? ""}`); process.exit(0); }
  const r = await call(tok, "POST", `https://firebasestorage.googleapis.com/v1beta/projects/${a}/defaultBucket`, { location: REGION }, a);
  if (!r.ok && !/already/i.test(msg(r))) die(`Could not create the storage bucket: ${msg(r)}`);
  console.log("created");
} else die("usage: gcp.mjs billing-status|billing-accounts|billing-link|enable-apis|auth-email|storage-bucket <project> [account]");
