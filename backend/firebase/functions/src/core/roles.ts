/**
 * Roles and capabilities. This is the server-side source of truth; Firestore rules
 * mirror the same matrix for direct client access.
 */
export const ROLES = ["owner", "admin", "adult", "child", "staff"] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  "household.manage",
  "members.manage",
  "members.read",
  "tasks.read.all",
  "tasks.write",
  "tasks.assign",
  "tasks.complete.assigned",
  "shopping.write",
  "pantry.write",
  "meals.write",
  "finance.read",
  "finance.write",
  "bills.pay.record",
  "maintenance.write",
  "inventory.read",
  "inventory.write",
  "calendar.write",
  "documents.read",
  "documents.write",
  "reports.read",
  "agent.use",
  "approvals.decide",
  "autonomy.manage",
  "usage.read",
  "jobs.manage",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const ADULT: Capability[] = [
  "members.read", "tasks.read.all", "tasks.write", "tasks.assign", "tasks.complete.assigned",
  "shopping.write", "pantry.write", "meals.write", "finance.read", "finance.write", "bills.pay.record",
  "maintenance.write", "inventory.read", "inventory.write", "calendar.write", "documents.read",
  "documents.write", "reports.read", "agent.use", "approvals.decide",
];

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  owner: new Set(CAPABILITIES),
  admin: new Set<Capability>([...ADULT, "household.manage", "members.manage", "autonomy.manage", "usage.read", "jobs.manage"]),
  adult: new Set(ADULT),
  child: new Set<Capability>(["members.read", "tasks.complete.assigned", "shopping.write", "calendar.write", "agent.use"]),
  staff: new Set<Capability>(["members.read", "tasks.complete.assigned", "shopping.write", "pantry.write"]),
};

export interface MemberPermissions {
  finance?: boolean; // adults only; default true
  agent?: boolean; // default per role
}

export interface Membership {
  uid: string;
  role: Role;
  status: "active" | "invited" | "removed";
  permissions?: MemberPermissions;
}

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

export function can(member: Membership | null | undefined, capability: Capability): boolean {
  if (!member || member.status !== "active") return false;
  if (!ROLE_CAPABILITIES[member.role].has(capability)) return false;
  if ((capability === "finance.read" || capability === "finance.write" || capability === "bills.pay.record")
      && member.permissions?.finance === false) {
    return false;
  }
  if (capability === "agent.use" && member.permissions?.agent === false) return false;
  return true;
}

/** Role hierarchy for "who may change whom". Staff/child are below adult. */
const RANK: Record<Role, number> = { owner: 4, admin: 3, adult: 2, child: 1, staff: 1 };

export function canChangeRole(actor: Membership, target: Membership, nextRole: Role): boolean {
  if (!can(actor, "members.manage")) return false;
  if (actor.uid === target.uid) return false; // nobody edits their own role
  if (nextRole === "owner") return actor.role === "owner"; // ownership transfer: owner only
  if (target.role === "owner") return false;
  return RANK[actor.role] > RANK[target.role] && RANK[actor.role] > RANK[nextRole];
}
