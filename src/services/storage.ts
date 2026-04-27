import { invoke } from '@tauri-apps/api/core'
import type { AppSettings, Holding, Recommendation } from '../types'

const settingsKey = 'investbuddy.settings'
const holdingsKey = 'investbuddy.holdings'
const snapshotKey = 'investbuddy.market_snapshot'

export interface MarketSnapshot {
  allRecommendations: Recommendation[]
  timestamp: number
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

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

export async function loadMarketSnapshot(): Promise<MarketSnapshot | null> {
  if (isTauri()) {
    try {
      const result = await invoke<[number, string] | null>('db_load_latest_snapshot')
      if (!result) return null
      const [timestamp, data] = result
      const allRecommendations = JSON.parse(data) as Recommendation[]
      return { allRecommendations, timestamp }
    } catch {
      // fall through to localStorage
    }
  }

  const raw = localStorage.getItem(snapshotKey)
  if (!raw) return null
  try {
    const snap = JSON.parse(raw) as MarketSnapshot
    if (!Array.isArray(snap.allRecommendations) || !snap.timestamp) return null
    return snap
  } catch {
    return null
  }
}

export async function saveMarketSnapshot(allRecommendations: Recommendation[], timestamp: number): Promise<void> {
  if (isTauri()) {
    try {
      await invoke('db_save_snapshot', { data: JSON.stringify(allRecommendations), timestamp })
      return
    } catch {
      // fall through to localStorage
    }
  }

  localStorage.setItem(snapshotKey, JSON.stringify({ allRecommendations, timestamp }))
}
