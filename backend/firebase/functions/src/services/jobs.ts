import { DateTime } from "luxon";
import { Timestamp } from "firebase-admin/firestore";
import { Actor, audit, Ctx, invalid, notFound, paths, requireCapability, ts } from "./base";import { notify } from "./notifications";
import { computeBriefing } from "./reports";
import { getBudgetSummary } from "./finance";

export type JobType =
  | "morning_briefing" | "evening_priorities" | "bill_deadline_check" | "pantry_threshold_check"
  | "weekly_meal_planning" | "weekly_summary" | "monthly_budget_review" | "monthly_maintenance_review";

export interface JobSchedule {
  kind: "daily" | "weekly" | "monthly";
  time: string; // HH:mm local
  weekday?: number; // 1–7 (weekly)
  monthDay?: number; // 1–28 (monthly)
}

/** Only weekly meal planning genuinely needs agent reasoning; everything else is deterministic. */
export const AGENT_JOBS: ReadonlySet<JobType> = new Set(["weekly_meal_planning"]);

export function computeNextRun(schedule: JobSchedule, timezone: string, after: Date): Date {
  const [hour, minute] = schedule.time.split(":").map(Number);
  let t = DateTime.fromJSDate(after).setZone(timezone).set({ hour, minute, second: 0, millisecond: 0 });
  const isMatch = (d: DateTime) =>
    schedule.kind === "daily" ||
    (schedule.kind === "weekly" && d.weekday === (schedule.weekday ?? 1)) ||
    (schedule.kind === "monthly" && d.day === (schedule.monthDay ?? 1));
  for (let i = 0; i < 400; i++) {
    if (t.toJSDate() > after && isMatch(t)) return t.toJSDate();
    t = t.plus({ days: 1 }).set({ hour, minute });
  }
  throw new Error("Could not compute next run");
}

export function defaultJobs(hid: string, ownerUid: string, timezone: string, now: Date) {
  const defs: Array<{ type: JobType; schedule: JobSchedule; enabled: boolean }> = [
    { type: "morning_briefing", schedule: { kind: "daily", time: "07:30" }, enabled: true },
    { type: "evening_priorities", schedule: { kind: "daily", time: "20:00" }, enabled: false },
    { type: "bill_deadline_check", schedule: { kind: "daily", time: "09:00" }, enabled: true },
    { type: "pantry_threshold_check", schedule: { kind: "daily", time: "18:00" }, enabled: true },
    { type: "weekly_meal_planning", schedule: { kind: "weekly", time: "10:00", weekday: 7 }, enabled: false },
    { type: "weekly_summary", schedule: { kind: "weekly", time: "19:00", weekday: 7 }, enabled: true },
    { type: "monthly_budget_review", schedule: { kind: "monthly", time: "09:00", monthDay: 1 }, enabled: true },
    { type: "monthly_maintenance_review", schedule: { kind: "monthly", time: "10:00", monthDay: 1 }, enabled: true },
  ];
  return defs.map((d) => ({
    id: d.type,
    data: {
      householdId: hid, type: d.type, ownerUid, schedule: d.schedule, timezone, enabled: d.enabled,
      requiresAgent: AGENT_JOBS.has(d.type),
      nextRunAt: Timestamp.fromDate(computeNextRun(d.schedule, timezone, now)),
      lastRunAt: null, lastStatus: null, lastError: null, failureCount: 0,
      retryPolicy: { maxRetries: 3, backoffMinutes: 15 }, leaseUntil: null,
      createdAt: Timestamp.fromDate(now),
    },
  }));
}

export async function updateJob(
  ctx: Ctx, actor: Actor, hid: string, jobId: string,
  input: { action: "pause" | "resume" | "edit" | "delete"; schedule?: JobSchedule },
) {
  await requireCapability(ctx, hid, actor.uid, "jobs.manage");
  const ref = ctx.db.doc(`${paths.col(hid, "scheduledJobs")}/${jobId}`);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Scheduled job");
  const job = snap.data()!;
  if (input.action === "delete") {
    await ref.delete();
  } else if (input.action === "pause") {
    await ref.update({ enabled: false });
  } else if (input.action === "resume") {
    await ref.update({ enabled: true, failureCount: 0, nextRunAt: Timestamp.fromDate(computeNextRun(job.schedule, job.timezone, ctx.now())) });
  } else {
    if (!input.schedule || !/^\d{2}:\d{2}$/.test(input.schedule.time)) throw invalid("A valid schedule is required");
    await ref.update({ schedule: input.schedule, nextRunAt: Timestamp.fromDate(computeNextRun(input.schedule, job.timezone, ctx.now())) });
  }
  await audit(ctx, hid, actor, `job.${input.action}`, { type: "scheduledJob", id: jobId });
}

export type AgentDispatcher = (hid: string, ownerUid: string, jobType: JobType, runKey: string) => Promise<{ status: string }>;

/**
 * Executes due jobs. Safe to run concurrently from multiple scheduler instances:
 *  - a transaction takes a short lease on each job before running it;
 *  - a run record keyed by (job, scheduled slot) is created with `create()`, so a
 *    slot can only ever execute once even if a lease expires mid-run.
 */
export const DEVICE_GRACE_MS = 6 * 3600_000;

/**
 * Hermes Mobile claims the current slot of an agent job before running it on the phone.
 * The claim is the same exclusive run record the server uses, so a slot runs exactly once
 * — on the device, or on the server after the grace period, never both.
 */
export async function claimJobForDevice(ctx: Ctx, actor: Actor, hid: string, jobId: string) {
  await requireCapability(ctx, hid, actor.uid, "agent.use");
  const ref = ctx.db.doc(`${paths.col(hid, "scheduledJobs")}/${jobId}`);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("Scheduled job");
  const job = snap.data()!;
  if (!job.requiresAgent || !job.enabled) return { claimed: false, reason: "not_an_agent_job" };
  const slot = job.nextRunAt.toDate() as Date;
  if (slot > ctx.now()) return { claimed: false, reason: "not_due", nextRunAt: slot.toISOString() };
  try {
    await ref.collection("runs").doc(String(slot.getTime())).create({ startedAt: ts(ctx.now()), status: "device_running", device: true, claimedBy: actor.uid });
  } catch (e: unknown) {
    if ((e as { code?: number }).code === 6) return { claimed: false, reason: "already_ran" };
    throw e;
  }
  await ref.update({ lastRunAt: ts(ctx.now()), lastStatus: "dispatched_to_device", nextRunAt: Timestamp.fromDate(computeNextRun(job.schedule, job.timezone, ctx.now())) });
  return {
    claimed: true, slot: slot.toISOString(),
    message: jobId === "weekly_meal_planning"
      ? "Plan next week's meals from our preferences and pantry, then generate the shopping list. Ask for approval where required."
      : "Run the scheduled household review.",
  };
}

export async function runDueJobs(ctx: Ctx, opts: { dispatchAgent?: AgentDispatcher; limit?: number; deviceGraceMs?: number } = {}) {
  const now = ctx.now();
  const due = await ctx.db.collectionGroup("scheduledJobs").where("enabled", "==", true)
    .where("nextRunAt", "<=", Timestamp.fromDate(now)).limit(opts.limit ?? 100).get();
  const results: Array<{ job: string; status: string }> = [];
  for (const doc of due.docs) {
    const leased = await ctx.db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const j = fresh.data();
      if (!j || !j.enabled || j.nextRunAt.toDate() > now) return null;
      if (j.leaseUntil && j.leaseUntil.toDate() > now) return null;
      tx.update(doc.ref, { leaseUntil: Timestamp.fromDate(new Date(now.getTime() + 5 * 60_000)) });
      return j;
    });
    if (!leased) continue;
    const slot = leased.nextRunAt.toDate() as Date;
    const runKey = `${doc.id}_${slot.getTime()}`;
    const runRef = doc.ref.collection("runs").doc(String(slot.getTime()));
    // Agent jobs belong to Hermes Mobile first (it runs them while charging). The server
    // Hermes only takes over once the device grace period has passed without a claim.
    if (leased.requiresAgent) {
      const grace = opts.deviceGraceMs ?? DEVICE_GRACE_MS;
      const claimed = (await runRef.get()).exists;
      if (!claimed && now.getTime() < slot.getTime() + grace) {
        await doc.ref.update({ leaseUntil: null });
        results.push({ job: runKey, status: "waiting_for_device" });
        continue;
      }
    }
    try {
      await runRef.create({ startedAt: ts(now), status: "running" });
    } catch (e: unknown) {
      if ((e as { code?: number }).code !== 6) throw e;
      // This slot already ran: just advance.
      await doc.ref.update({ leaseUntil: null, nextRunAt: Timestamp.fromDate(computeNextRun(leased.schedule, leased.timezone, now)) });
      results.push({ job: runKey, status: "duplicate_skipped" });
      continue;
    }
    let status = "succeeded";
    let error: string | null = null;
    try {
      status = await executeJob(ctx, leased.householdId, leased.ownerUid, leased.type as JobType, runKey, opts.dispatchAgent);
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
    }
    const failures = status === "failed" ? (leased.failureCount ?? 0) + 1 : 0;
    const retry = status === "failed" && failures <= (leased.retryPolicy?.maxRetries ?? 3);
    const nextRunAt = retry
      ? new Date(now.getTime() + (leased.retryPolicy?.backoffMinutes ?? 15) * 60_000 * 2 ** (failures - 1))
      : computeNextRun(leased.schedule, leased.timezone, now);
    await runRef.update({ status, error, finishedAt: ts(ctx.now()) });
    await doc.ref.update({
      lastRunAt: ts(now), lastStatus: status, lastError: error, failureCount: failures, leaseUntil: null,
      nextRunAt: Timestamp.fromDate(nextRunAt),
    });
    results.push({ job: runKey, status });
  }
  return results;
}

async function managerUids(ctx: Ctx, hid: string, roles = ["owner", "admin", "adult"]): Promise<string[]> {
  const s = await ctx.db.collection(paths.col(hid, "members")).where("status", "==", "active").get();
  return s.docs.filter((d) => roles.includes(d.data().role)).map((d) => d.id);
}

async function executeJob(ctx: Ctx, hid: string, ownerUid: string, type: JobType, runKey: string, dispatchAgent?: AgentDispatcher): Promise<string> {
  const system: Actor = { uid: ownerUid, kind: "system" };
  switch (type) {
    case "morning_briefing":
    case "evening_priorities": {
      const members = await ctx.db.collection(paths.col(hid, "members")).where("status", "==", "active").get();
      for (const m of members.docs) {
        const b = await computeBriefing(ctx, hid, { uid: m.id, kind: "system" });
        if (b.summary === "Nothing urgent today." && type === "evening_priorities") continue;
        await notify(ctx, hid, {
          recipients: [m.id], category: "briefing",
          title: type === "morning_briefing" ? "Today at home" : "Tomorrow's priorities",
          body: b.summary, deepLink: "homehub://home", dedupeKey: `${runKey}`,
        });
      }
      return "succeeded";
    }
    case "bill_deadline_check": {
      const soon = Timestamp.fromDate(new Date(ctx.now().getTime() + 3 * 86400_000));
      const bills = await ctx.db.collection(paths.col(hid, "bills")).where("nextDueAt", "<=", soon).get();
      const recipients = await managerUids(ctx, hid);
      for (const b of bills.docs.filter((d) => d.data().active !== false)) {
        const due = b.data().nextDueAt.toDate() as Date;
        await notify(ctx, hid, {
          recipients, category: "bills", title: due < ctx.now() ? "Bill overdue" : "Bill due soon",
          body: `${b.data().name} is due ${due.toISOString().slice(0, 10)}`, deepLink: `homehub://bills/${b.id}`,
          dedupeKey: `bill:${b.id}:${due.getTime()}:${due < ctx.now() ? "overdue" : "soon"}`,
        });
      }
      return "succeeded";
    }
    case "pantry_threshold_check": {
      const low = await ctx.db.collection(paths.col(hid, "pantryItems")).where("lowStock", "==", true).get();
      if (low.empty) return "succeeded";
      const names = low.docs.map((d) => d.data().name).slice(0, 5).join(", ");
      await notify(ctx, hid, {
        recipients: await managerUids(ctx, hid, ["owner", "admin", "adult", "staff"]), category: "pantry",
        title: "Running low", body: `${low.size} item${low.size > 1 ? "s" : ""} low: ${names}`,
        deepLink: "homehub://pantry", dedupeKey: `pantry:${runKey}`,
      });
      return "succeeded";
    }
    case "weekly_summary":
    case "monthly_budget_review": {
      const tz = (await ctx.db.doc(paths.household(hid)).get()).data()?.timezone ?? "UTC";
      const period = DateTime.fromJSDate(ctx.now()).setZone(tz).minus({ days: type === "monthly_budget_review" ? 2 : 0 }).toFormat("yyyy-MM");
      const s = await getBudgetSummary(ctx, hid, system, period).catch(() => null);
      if (!s) return "succeeded";
      const over = s.categories.filter((c) => c.status === "over").map((c) => c.category);
      await notify(ctx, hid, {
        recipients: await managerUids(ctx, hid, ["owner", "admin"]), category: "briefing",
        title: type === "weekly_summary" ? "Weekly household summary" : "Monthly budget review",
        body: over.length ? `Over budget in ${over.join(", ")}` : "Spending is within budget.",
        deepLink: "homehub://insights", dedupeKey: `${runKey}`,
      });
      return "succeeded";
    }
    case "monthly_maintenance_review": {
      const soon = Timestamp.fromDate(new Date(ctx.now().getTime() + 31 * 86400_000));
      const assets = await ctx.db.collection(paths.col(hid, "assets")).where("nextServiceAt", "<=", soon).get();
      if (assets.empty) return "succeeded";
      await notify(ctx, hid, {
        recipients: await managerUids(ctx, hid), category: "maintenance", title: "Maintenance this month",
        body: assets.docs.map((d) => d.data().name).slice(0, 5).join(", "), deepLink: "homehub://maintenance", dedupeKey: `${runKey}`,
      });
      return "succeeded";
    }
    case "weekly_meal_planning": {
      if (!dispatchAgent) return "skipped_agent_unavailable";
      const r = await dispatchAgent(hid, ownerUid, type, runKey);
      return r.status;
    }
  }
}
