export type UiThemePreference = 'system' | 'light' | 'dark'
export type UiLanguagePreference = 'system' | 'zh' | 'en'

export interface AppTypography {
  display: number
  displayCompact: number
  pageTitle: number
  pageTitleCompact: number
  sectionTitle: number
  cardTitle: number
  metric: number
  body: number
  caption: number
  micro: number
  control: number
  controlCompact: number
  controlMin: number
  controlMaxScale: number
}

// Phone-first type scale. Display sizes stay deliberately restrained so
// Chinese, English and larger system font settings do not crowd fixed chrome.
export const APP_TYPOGRAPHY: AppTypography = {
  display: 24,
  displayCompact: 22,
  pageTitle: 20,
  pageTitleCompact: 18,
  sectionTitle: 16,
  cardTitle: 14,
  metric: 15,
  body: 12,
  caption: 10,
  micro: 9,
  // Controls keep a full 44/48 vp hit target while their labels stay compact.
  // `controlMin` is used by Button.labelStyle so long Chinese/English labels
  // shrink before they are ellipsized in split-screen and large-font modes.
  control: 10,
  controlCompact: 9,
  controlMin: 9,
  controlMaxScale: 1.3
}

export interface AppPalette {
  background: string
  backgroundGlow: string
  backgroundGlowSecondary: string
  surface: string
  surfaceElevated: string
  surfaceMuted: string
  surfaceGlass: string
  materialTint: string
  navigation: string
  border: string
  borderStrong: string
  textPrimary: string
  textSecondary: string
  textTertiary: string
  textDisabled: string
  placeholder: string
  accent: string
  accentStrong: string
  accentSoft: string
  accentForeground: string
  blue: string
  blueSoft: string
  warning: string
  warningSoft: string
  danger: string
  dangerSoft: string
  controlThumb: string
  shadow: string
  online: string
  offline: string
  starting: string
  badgeText: string
}

export const DARK_PALETTE: AppPalette = {
  background: '#101114',
  backgroundGlow: '#0A1B2B',
  backgroundGlowSecondary: '#121B39',
  surface: '#1C1D21',
  surfaceElevated: '#25262B',
  surfaceMuted: '#17181C',
  surfaceGlass: '#AE0E1A2B',
  materialTint: '#8C0A1220',
  navigation: '#08111F',
  border: '#2E4A66',
  borderStrong: '#43688F',
  textPrimary: '#FFFFFF',
  textSecondary: '#CFDBE9',
  textTertiary: '#A8BACE',
  textDisabled: '#8195AB',
  placeholder: '#93A8BF',
  accent: '#C7D0FF',
  accentStrong: '#B4C2FF',
  accentSoft: '#3A477A',
  accentForeground: '#111C43',
  blue: '#63A9FF',
  blueSoft: '#122A47',
  warning: '#FFBE72',
  warningSoft: '#342518',
  danger: '#FF7D8D',
  dangerSoft: '#351B27',
  controlThumb: '#FFFFFF',
  shadow: '#66000000',
  online: '#4CAF50',
  offline: '#9E9E9E',
  starting: '#FFEB3B',
  badgeText: '#FFFFFF'
}

export const LIGHT_PALETTE: AppPalette = {
  background: '#FAF8FF',
  backgroundGlow: '#D9F5EE',
  backgroundGlowSecondary: '#DEE8FF',
  surface: '#F5F3FA',
  surfaceElevated: '#E3E2E8',
  surfaceMuted: '#DAD9DF',
  surfaceGlass: '#C7FFFFFF',
  materialTint: '#BFFFFFFF',
  navigation: '#EEEDF5',
  border: '#C9DAE8',
  borderStrong: '#A9C2D6',
  textPrimary: '#0E0E12',
  textSecondary: '#33353D',
  textTertiary: '#47576A',
  textDisabled: '#5F7488',
  placeholder: '#5A6E82',
  accent: '#3F56A0',
  accentStrong: '#31479B',
  accentSoft: '#D5DFFF',
  accentForeground: '#FFFFFF',
  blue: '#145FAD',
  blueSoft: '#E4F0FF',
  warning: '#A55B08',
  warningSoft: '#FFF0DD',
  danger: '#A92E42',
  dangerSoft: '#FFE8EC',
  controlThumb: '#FFFFFF',
  shadow: '#1A18324A',
  online: '#4CAF50',
  offline: '#9E9E9E',
  starting: '#FFEB3B',
  badgeText: '#FFFFFF'
}

export const UI_PREFERENCES_FILE: string = 'ui-preferences-v1'
export const UI_LANGUAGE_KEY: string = 'language'
export const UI_THEME_KEY: string = 'theme'
export const UI_PRIVACY_CONSENT_KEY: string = 'privacy-consent-v1'

export function normalizedLanguagePreference(value: string): UiLanguagePreference {
  if (value === 'zh' || value === 'en') return value
  return 'system'
}

export function normalizedThemePreference(value: string): UiThemePreference {
  if (value === 'light' || value === 'dark') return value
  return 'system'
}
