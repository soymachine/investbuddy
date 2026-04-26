import type { AppSettings, CurrencyCode, SignalScore, WatchlistItem } from '../types'
import { invoke } from '@tauri-apps/api/core'

export interface LiveMarketData {
  price?: number
  signal: Partial<SignalScore>
  sources: string[]
  warnings: string[]
}

const eurRates: Record<CurrencyCode, number> = {
  EUR: 1,
  USD: 0.93,
  GBP: 1.16,
  CHF: 1.05,
  DKK: 0.13,
}

export function hasMinimumDataAccess(settings: AppSettings): boolean {
  return Boolean(settings.finnhubApiKey && settings.marketauxApiKey && settings.eulerpoolApiKey)
}

export function getProviderStatus(settings: AppSettings): Record<string, boolean> {
  return {
    Finnhub: Boolean(settings.finnhubApiKey),
    Marketaux: Boolean(settings.marketauxApiKey),
    Eulerpool: Boolean(settings.eulerpoolApiKey),
    'SEC EDGAR': Boolean(settings.secUserAgent),
    'Alpha Vantage': Boolean(settings.alphaVantageApiKey),
    FMP: Boolean(settings.fmpApiKey),
    EODHD: Boolean(settings.eodhdApiKey),
  }
}

export function toEur(amount: number, currency: CurrencyCode): number {
  return amount * eurRates[currency]
}

export function fromEur(amount: number, currency: CurrencyCode): number {
  return amount / eurRates[currency]
}

export function mockCurrentPrice(stock: WatchlistItem): number {
  const base = seeded(stock.symbol, 42)
  const scale = stock.currency === 'DKK' ? 900 : stock.currency === 'GBP' ? 130 : 520
  const price = 18 + base * scale
  return Number(price.toFixed(2))
}

export function mockSignal(stock: WatchlistItem): SignalScore {
  const regionalBoost = stock.region === 'US' ? 8 : 0
  const techBoost = ['Technology', 'Semiconductors', 'Software'].includes(stock.sector) ? 6 : 0
  const defensiveBoost = ['Healthcare', 'Consumer'].includes(stock.sector) ? 4 : 0
  const raw = seeded(stock.symbol, 7)

  return {
    momentum: clamp(42 + raw * 46 + techBoost),
    trend: clamp(38 + seeded(stock.symbol, 11) * 48 + techBoost),
    stability: clamp(44 + seeded(stock.symbol, 19) * 38 + defensiveBoost),
    volume: clamp(36 + seeded(stock.symbol, 23) * 52),
    sentiment: clamp(34 + seeded(stock.symbol, 29) * 54),
    insider: stock.region === 'US' ? clamp(30 + seeded(stock.symbol, 31) * 50 + regionalBoost) : null,
    risk: clamp(20 + seeded(stock.symbol, 37) * 62),
  }
}

export async function fetchLiveMarketData(stock: WatchlistItem, settings: AppSettings): Promise<LiveMarketData> {
  const [finnhub, marketaux, eulerpool] = await Promise.all([
    fetchFinnhubData(stock, settings),
    fetchMarketauxData(stock, settings),
    fetchEulerpoolData(stock, settings),
  ])

  return mergeLiveData([finnhub, marketaux, eulerpool])
}

async function fetchFinnhubData(stock: WatchlistItem, settings: AppSettings): Promise<LiveMarketData> {
  if (!settings.finnhubApiKey || stock.region !== 'US') {
    return emptyLiveData()
  }

  const warnings: string[] = []
  const sources: string[] = []
  let price: number | undefined
  const signal: Partial<SignalScore> = {}

  try {
    const quoteUrl = new URL('https://finnhub.io/api/v1/quote')
    quoteUrl.searchParams.set('symbol', stock.symbol)
    quoteUrl.searchParams.set('token', settings.finnhubApiKey)
    const quote = await fetchJson<Record<string, number>>(quoteUrl)

    if (quote.c > 0) {
      price = Number(quote.c.toFixed(2))
      sources.push('Finnhub quote')
    }
  } catch {
    warnings.push('Finnhub quote no disponible; usando fallback local.')
  }

  try {
    const now = Math.floor(Date.now() / 1000)
    const from = now - 370 * 24 * 60 * 60
    const candleUrl = new URL('https://finnhub.io/api/v1/stock/candle')
    candleUrl.searchParams.set('symbol', stock.symbol)
    candleUrl.searchParams.set('resolution', 'D')
    candleUrl.searchParams.set('from', String(from))
    candleUrl.searchParams.set('to', String(now))
    candleUrl.searchParams.set('token', settings.finnhubApiKey)
    const candles = await fetchJson<{ s: string; c?: number[]; v?: number[] }>(candleUrl)

    if (candles.s === 'ok' && candles.c && candles.c.length > 20) {
      Object.assign(signal, signalFromCandles(candles.c, candles.v ?? []))
      sources.push('Finnhub candles')
    }
  } catch {
    warnings.push('Finnhub historical no disponible; usando historico estimado.')
  }

  return { price, signal, sources, warnings }
}

async function fetchMarketauxData(stock: WatchlistItem, settings: AppSettings): Promise<LiveMarketData> {
  if (!settings.marketauxApiKey) {
    return emptyLiveData()
  }

  try {
    const url = new URL('https://api.marketaux.com/v1/news/all')
    url.searchParams.set('symbols', stock.symbol)
    url.searchParams.set('filter_entities', 'true')
    url.searchParams.set('must_have_entities', 'true')
    url.searchParams.set('language', 'en')
    url.searchParams.set('limit', '3')
    url.searchParams.set('api_token', settings.marketauxApiKey)

    const response = await fetchJson<{ data?: MarketauxArticle[] }>(url)
    const scores = (response.data ?? [])
      .flatMap((article) => article.entities ?? [])
      .filter((entity) => entity.symbol?.toUpperCase() === stock.symbol.toUpperCase())
      .map((entity) => entity.sentiment_score)
      .filter((score): score is number => typeof score === 'number')

    if (!scores.length) return emptyLiveData()

    const average = scores.reduce((total, score) => total + score, 0) / scores.length
    return {
      signal: { sentiment: clamp((average + 1) * 50) },
      sources: ['Marketaux sentiment'],
      warnings: [],
    }
  } catch {
    return { signal: {}, sources: [], warnings: ['Marketaux no disponible; sentimiento estimado.'] }
  }
}

async function fetchEulerpoolData(stock: WatchlistItem, settings: AppSettings): Promise<LiveMarketData> {
  if (!settings.eulerpoolApiKey) {
    return emptyLiveData()
  }

  try {
    const url = new URL(`https://api.eulerpool.com/api/1/equity/price/${encodeURIComponent(stock.symbol)}`)
    url.searchParams.set('token', settings.eulerpoolApiKey)
    const data = await fetchJson<Record<string, unknown>>(url)
    const price = firstNumber(data, ['price', 'close', 'last', 'current_price', 'currentPrice'])

    if (!price || price <= 0) return emptyLiveData()

    return { price: Number(price.toFixed(2)), signal: {}, sources: ['Eulerpool price'], warnings: [] }
  } catch {
    return { signal: {}, sources: [], warnings: ['Eulerpool no disponible para este simbolo; usando fallback.'] }
  }
}

function signalFromCandles(closes: number[], volumes: number[]): Partial<SignalScore> {
  const last = closes.at(-1) ?? 0
  const close7 = closes.at(-8) ?? closes[0]
  const close30 = closes.at(-31) ?? closes[0]
  const close90 = closes.at(-91) ?? closes[0]
  const momentumReturn = (pct(last, close7) * 0.35 + pct(last, close30) * 0.45 + pct(last, close90) * 0.2) * 100
  const sma20 = average(closes.slice(-20))
  const sma50 = average(closes.slice(-50))
  const recentVolumes = volumes.slice(-10)
  const baselineVolumes = volumes.slice(-60, -10)
  const volatility = stdev(closes.slice(-45).map((close, index, items) => (index ? pct(close, items[index - 1]) : 0)).slice(1))

  return {
    momentum: clamp(50 + momentumReturn * 1.35),
    trend: clamp(50 + pct(last, sma20) * 230 + pct(sma20, sma50) * 180),
    stability: clamp(86 - volatility * 900),
    volume: clamp(50 + pct(average(recentVolumes), average(baselineVolumes)) * 120),
    risk: clamp(22 + volatility * 900),
  }
}

function mergeLiveData(results: LiveMarketData[]): LiveMarketData {
  return results.reduce<LiveMarketData>(
    (merged, result) => ({
      price: result.price ?? merged.price,
      signal: { ...merged.signal, ...result.signal },
      sources: [...merged.sources, ...result.sources],
      warnings: [...merged.warnings, ...result.warnings],
    }),
    emptyLiveData(),
  )
}

function emptyLiveData(): LiveMarketData {
  return { signal: {}, sources: [], warnings: [] }
}

async function fetchJson<T>(url: URL): Promise<T> {
  if ('__TAURI_INTERNALS__' in window) {
    return invoke<T>('http_get_json', { url: url.toString() })
  }

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 9000)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as T
  } finally {
    window.clearTimeout(timeout)
  }
}

function pct(current: number, previous: number): number {
  if (!previous) return 0
  return (current - previous) / previous
}

function average(values: number[]): number {
  const valid = values.filter((value) => Number.isFinite(value) && value > 0)
  if (!valid.length) return 0
  return valid.reduce((total, value) => total + value, 0) / valid.length
}

function stdev(values: number[]): number {
  if (!values.length) return 0
  const avg = values.reduce((total, value) => total + value, 0) / values.length
  const variance = values.reduce((total, value) => total + (value - avg) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function firstNumber(data: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'number') return value
    if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) return Number(value)
  }

  return undefined
}

interface MarketauxArticle {
  entities?: Array<{
    symbol?: string
    sentiment_score?: number
  }>
}

function seeded(value: string, salt: number): number {
  let hash = salt
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) % 9973
  }
  return (hash % 1000) / 1000
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Number(value.toFixed(1))))
}
