import { NtExecutable, NtExecutableResource } from 'pe-library';
import MuiResourceInfo from './MuiResourceInfo.js';
/** The record of known LANGID (each numeric key is LANGID) and the language tag */
export declare const langIdToLanguageTagMap: Record<number, string>;
/**
 * Converts LANGID value to known language tag.
 * The language tag is used for `language` of {@linkcode MuiResourceData}, and the directory name which contains localized MUI executable.
 */
export declare function langIdToLanguageTag(langId: number): string;
/**
 * Generates checksum binary for MUI.
 * This function simply generates random 16-byte binary without reproducibility, since
 * Windows does not check whether the checksum value itself is valid.
 * - For generating the new LN and MUI resources, you can use this function twice,
 *   for main checksum and for service checksum, and set them.
 * - For editing existing LN and MUI resources, you should use this function only if:
 *   - the file name or the version is changed : main checksum should be rewrited.
 *   - the resource entries are added/removed, or the meaning of the resource is changed : service checksum should be rewrited.
 *
 *   If none of above condition is met, you should not rewrite checksums.
 */
export declare function createChecksumBinary(): Uint8Array;
/**
 * Makes the new MUI resource data for MUI (localized) binary from existing LN (neutral) binary.
 * @param neutralMuiResource An MUI resource data ({@linkcode MuiResourceInfo}) for LN binary
 * @param langTag The language tag (e.g. `'en-US'`) for the return value
 * @returns new `MuiResourceInfo` instance
 */
export declare function makeLocalizedMuiResourceFromNeutralMuiResource(neutralMuiResource: MuiResourceInfo, langTag: string): MuiResourceInfo;
/**
 * Makes (splits) MUI resource executables from one executable containing multiple language resources.
 * @param baseExecutableResource Base executable data which contains all localized resources.
 *   Note that the resource entries of `baseExecutableResource` will be modified in place.
 * @param neutralResources Resource types which should be included in the LN resource binary
 * @param localizedResources Resource types which should be included in the MUI resource binaries.
 *   Can include the types included in `neutralResources`.
 * @param defaultLangId The LANGID value for the default language. This is used for fallback language value and
 *   picking up resources stored to the LN executable (for the resource of `neutralResources` which is also included in `localizedResources`).
 * @param is32bit true if requiring `NtExecutable` be 32-bit executable.
 * @returns Splitted LN executable resource (`baseExecutableResource`) and tuple of MUI executables (`muiExecutables`)
 */
export declare function makeMuiResourcesFromSingleExecutable(baseExecutableResource: NtExecutableResource, neutralResources: ReadonlyArray<string | number>, localizedResources: ReadonlyArray<string | number>, defaultLangId: number, is32bit?: boolean, fallbackLangIdIfLocalizedNotExist?: number): {
    /** LN executable resource. This instance is equal to `baseExecutableResource` parameter of {@linkcode makeMuiResourcesFromSingleExecutable}. */
    baseExecutableResource: NtExecutableResource;
    /**
     * Array of tuple of language tag (e.g. `en-US`) and generated MUI executable (`NtExecutable`; not `NtExecutableResource`).
     * To write to file, use the language tag as the directory name.
     */
    muiExecutables: ReadonlyArray<[langTag: string, executable: NtExecutable]>;
};
/**
 * Makes (splits) MUI resource executables from one executable containing multiple language resources.
 * This function calculates and uses `neutralResources` and `localizedResources` for {@linkcode makeMuiResourcesFromSingleExecutable}.
 * Note that this function does not include icons into localized resources.
 * To include icons, use `makeMuiResourcesFromSingleExecutable`.
 * @param baseExecutableResource Base executable data which contains all localized resources.
 *   Note that the resource entries of `baseExecutableResource` will be modified in place.
 * @param defaultLangId The LANGID value for the default language. This is used for fallback language value and
 *   picking up resources stored to the LN executable (for the resource of `neutralResources` which is also included in `localizedResources`).
 * @param is32bit true if requiring `NtExecutable` be 32-bit executable.
 * @returns Splitted LN executable resource (`baseExecutableResource`) and tuple of MUI executables (`muiExecutables`)
 */
export declare function makeMuiResourcesFromSingleExecutableAuto(baseExecutableResource: NtExecutableResource, defaultLangId: number, is32bit?: boolean, fallbackLangIdIfLocalizedNotExist?: number): {
    /** LN executable resource. This instance is equal to `baseExecutableResource` parameter of {@linkcode makeMuiResourcesFromSingleExecutable}. */
    baseExecutableResource: NtExecutableResource;
    /**
     * Array of tuple of language tag (e.g. `en-US`) and generated MUI executable (`NtExecutable`; not `NtExecutableResource`).
     * To write to file, use the language tag as the directory name.
     */
    muiExecutables: ReadonlyArray<[langTag: string, executable: NtExecutable]>;
};
