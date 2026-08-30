/**
 * Ambient declaration for the single OpenClaw SDK subpath this plugin imports
 * at runtime.
 *
 * `openclaw` is a peer dependency, not a build dependency: the guard must stay
 * installable and testable without pulling the whole host package into CI. The
 * shape below mirrors `definePluginEntry` from
 * `openclaw/plugin-sdk/plugin-entry` in `openclaw@2026.7.1-2`.
 *
 * The plugin never imports the deprecated root barrel (`openclaw/plugin-sdk`).
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  import type { GuardHostApi } from "../host-contract.ts";

  export type OpenClawPluginApi = GuardHostApi;

  export type DefinePluginEntryOptions = {
    id: string;
    name: string;
    description: string;
    register: (api: OpenClawPluginApi) => void;
  };

  export function definePluginEntry(options: DefinePluginEntryOptions): unknown;
}
