import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { PLUGIN_ID, registerGuard } from "./register.ts";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "ACP Report Guard",
  description:
    "Validates canonical ACP lifecycle reports and cancels malformed ones before delivery.",
  register: registerGuard,
});
