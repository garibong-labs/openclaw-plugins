import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { PLUGIN_ID, registerGuard } from "./register.ts";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "ACP Lifecycle Guard",
  description:
    "Validates ACP lifecycle reports and runs a durable, fenced report-delivery controller.",
  register: registerGuard,
});
