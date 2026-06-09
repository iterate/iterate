// Back-compat shim: the config utilities are not "apps framework" concerns and
// now live at @iterate-com/shared/config. Import from there in new code; this
// module only keeps existing @iterate-com/shared/apps/config importers working.
export * from "../config.ts";
