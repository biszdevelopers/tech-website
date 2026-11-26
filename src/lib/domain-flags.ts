import { strandColumnNames } from "./tl-config";

export const DOMAIN_COLUMNS = strandColumnNames();

export function domainFlagsFromFields(fields: Record<string, unknown>): Record<string, boolean> {
    const flags: Record<string, boolean> = {};
    for (const field of DOMAIN_COLUMNS) {
        const value = fields[field];
        flags[field] = value === true || value === "on" || value === "true" || value === "1";
    }
    return flags;
}

export function atLeastOneFlag(flags: Record<string, boolean>): boolean {
    return Object.values(flags).some(Boolean);
}
