import type { AppSettings, Holding } from '../types'

const settingsKey = 'investbuddy.settings'
const holdingsKey = 'investbuddy.holdings'

export const defaultSettings: AppSettings = {
  finnhubApiKey: import.meta.env.VITE_FINNHUB_API_KEY ?? '',
  marketauxApiKey: import.meta.env.VITE_MARKETAUX_API_KEY ?? '',
  eulerpoolApiKey: import.meta.env.VITE_EULERPOOL_API_KEY ?? '',
  alphaVantageApiKey: import.meta.env.VITE_ALPHA_VANTAGE_API_KEY ?? '',
  fmpApiKey: import.meta.env.VITE_FMP_API_KEY ?? '',
  eodhdApiKey: import.meta.env.VITE_EODHD_API_KEY ?? '',
  secUserAgent: import.meta.env.VITE_SEC_USER_AGENT ?? '',
  riskProfile: 'balanced',
}

export function loadSettings(): AppSettings {
  const raw = localStorage.getItem(settingsKey)
  if (!raw) return defaultSettings

  try {
    return { ...defaultSettings, ...JSON.parse(raw) }
  } catch {
    return defaultSettings
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(settingsKey, JSON.stringify(settings))
}

export function loadHoldings(): Holding[] {
  const raw = localStorage.getItem(holdingsKey)
  if (!raw) return []

  try {
    const holdings = JSON.parse(raw)
    return Array.isArray(holdings) ? holdings : []
  } catch {
    return []
  }
}

export function saveHoldings(holdings: Holding[]): void {
  localStorage.setItem(holdingsKey, JSON.stringify(holdings))
}
