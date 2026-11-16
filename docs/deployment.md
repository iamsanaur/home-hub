# Deployment, backup and recovery

## Deploy (after `firebase-setup.md`)
```bash
source scripts/dev-env.sh
cd backend/firebase/functions && npm ci && npm run build && npm run test:unit
cd .. && firebase emulators:exec --only auth,firestore,storage "cd functions && npm run test:emulator"
firebase deploy --project <prod-id> --only firestore:rules,firestore:indexes,storage,functions
```
Android release: `keystore.properties` (git-ignored) then `./gradlew :app:bundleRelease`. iOS: archive in Xcode with your team.

## Backup
- Firestore: enable **Point-in-time recovery** (7 days) and scheduled exports:
  `gcloud firestore export gs://<bucket>/backups/$(date +%F)` via Cloud Scheduler daily; retain 30 days with a lifecycle rule.
- Storage: enable object versioning + soft delete on the bucket.
- Secrets: Secret Manager keeps versions; record rotation dates.

## Recovery
1. Pause the agent globally if data corruption is suspected (`autonomy.paused` per household, or disable the `scheduler` function).
2. Restore: `gcloud firestore import gs://<bucket>/backups/<date>` into a staging project first; verify; then import or use PITR reads to repair specific documents.
3. Re-run `firebase deploy --only firestore:rules` to ensure rules match the release.
4. Audit trail (`activityLogs`) and usage ledger identify agent-made changes by `workflowId`.

## Operations
Watch Functions error rates, scheduler run statuses (`scheduledJobs.lastStatus`), `agentWorkflows` stuck in `executing` (reconciled automatically), and model-proxy 429/503 rates.
