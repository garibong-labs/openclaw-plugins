import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { PLUGIN_ID, registerGuard } from "./register.ts";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "ACP Lifecycle Guard",
  description:
    "Validates canonical ACP lifecycle reports, cancels malformed ones before delivery, restricts agent-started ACP launch routes to the main agent, and tracks owner-checkpoint delivery receipts.",
  register: registerGuard,
});
