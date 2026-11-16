import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { Ctx, sha256, ts } from "../services/base";

/**
 * Integration secrets (API keys, OAuth tokens). Firestore stores only references
 * (`integrationSecretsRefs`), never values. Production: Google Secret Manager.
 * Emulator/tests: a server-only collection that rules deny to every client, and that
 * refuses to run outside the emulator.
 */
export interface SecretStore {
  put(name: string, value: string): Promise<string>; // returns a reference
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
}

export class GoogleSecretStore implements SecretStore {
  private client = new SecretManagerServiceClient();
  constructor(private readonly project: string) {}
  async put(name: string, value: string) {
    const id = `homehub-${name}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 255);
    const parent = `projects/${this.project}`;
    try { await this.client.createSecret({ parent, secretId: id, secret: { replication: { automatic: {} } } }); } catch (e) { if ((e as { code?: number }).code !== 6) throw e; }
    const [v] = await this.client.addSecretVersion({ parent: `${parent}/secrets/${id}`, payload: { data: Buffer.from(value, "utf8") } });
    return v.name!;
  }
  async get(ref: string) {
    const [v] = await this.client.accessSecretVersion({ name: ref });
    return v.payload?.data ? Buffer.from(v.payload.data as Uint8Array).toString("utf8") : null;
  }
  async delete(ref: string) {
    await this.client.deleteSecret({ name: ref.split("/versions/")[0] }).catch(() => undefined);
  }
}

export class EmulatorSecretStore implements SecretStore {
  constructor(private readonly ctx: Ctx) {
    if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("EmulatorSecretStore is for the emulator only");
  }
  async put(name: string, value: string) {
    const ref = `emulator://${sha256(name + Date.now() + Math.random()).slice(0, 32)}`;
    await this.ctx.db.doc(`_devSecrets/${ref.slice(11)}`).set({ name, value, createdAt: ts(this.ctx.now()) });
    return ref;
  }
  async get(ref: string) {
    const s = await this.ctx.db.doc(`_devSecrets/${ref.replace("emulator://", "")}`).get();
    return s.exists ? (s.data()!.value as string) : null;
  }
  async delete(ref: string) { await this.ctx.db.doc(`_devSecrets/${ref.replace("emulator://", "")}`).delete(); }
}

export function defaultSecretStore(ctx: Ctx): SecretStore {
  if (process.env.FIRESTORE_EMULATOR_HOST) return new EmulatorSecretStore(ctx);
  return new GoogleSecretStore(process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT ?? "");
}
