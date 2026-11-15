// Build channel follows the bundled upstream core, never app version magnitude.
export const APP_VERSION: string = '1.0.4-beta'
export const CORE_VERSION: string = '1.15.0-alpha.13'
export function coreIsPrerelease(version: string): boolean { return /-/.test(version) }
export const RELEASES_URL: string = 'https://github.com/being123321/sing-box-for-harmonyos/releases'
