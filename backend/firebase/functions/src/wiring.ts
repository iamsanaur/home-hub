import { logger } from "firebase-functions";
import { deviceHooks } from "./devices/devices";
import { processEvent } from "./automations/automations";
import { sendChangeReport, SmartHomeDeps } from "./alexa/smartHome";

/**
 * Connects device state changes to automations and Alexa proactive reports. Kept out of the
 * device module so devices ↔ automations ↔ alexa have no import cycle. Both consumers are
 * best-effort: a failing automation or Alexa outage never fails the device update itself.
 */
export function installEventHooks(deps: { smartHome?: SmartHomeDeps } = {}) {
  deviceHooks.onStateChanged = async (ctx, hid, deviceId, changed, origin) => {
    for (const [property, value] of Object.entries(changed)) {
      await processEvent(ctx, hid, { type: "device.state_changed", deviceId, property, value, origin })
        .catch((e) => logger.warn("automation event failed", { hid, deviceId, property, error: String(e) }));
    }
    // Changes Alexa itself requested are already reported in the directive response.
    if (origin.channel === "alexa") return;
    const cause = origin.channel === "app" ? "APP_INTERACTION" : origin.channel === "automation" ? "RULE_TRIGGER" : "PHYSICAL_INTERACTION";
    await sendChangeReport(ctx, hid, deviceId, changed as Record<string, unknown>, cause, deps.smartHome)
      .catch((e) => logger.warn("alexa change report failed", { hid, deviceId, error: String(e) }));
  };
}
