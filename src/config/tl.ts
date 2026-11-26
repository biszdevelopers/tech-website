// Single import surface for TL configuration.
import { tlConfigs } from "../lib/tl-config";

export {
    tlConfigs,
    tlFields,
    tlList,
    getTlConfig,
    getStrand,
    type TLConfig,
    type StrandConfig,
} from "../lib/tl-config";

export function isValidTl(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(tlConfigs, id);
}

export type TlKey = keyof typeof tlConfigs;
