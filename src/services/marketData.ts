import type { AppSettings, CurrencyCode, SignalScore, WatchlistItem } from '../types'
import { invoke } from '@tauri-apps/api/core'
import { getCache, setCache, TTL } from './cache'

export interface LiveMarketData {
  price?: number
  signal: Partial<SignalScore>
  sources: string[]
  warnings: string[]
}

export interface PricePoint {
  date: string
  price: number
}

export interface PriceHistory {
  points: PricePoint[]
  source: string
}

// ── FX Rates (ECB via Frankfurter) ───────────────────────────────────────────

let liveEurRates: Record<CurrencyCode, number> = {
  EUR: 1,
  USD: 0.93,
  GBP: 1.16,
  CHF: 1.05,
  DKK: 0.13,
}

export async function refreshFxRates(): Promise<void> {
  const cached = getCache<Record<CurrencyCode, number>>('ecb_fx')
  if (cached) { liveEurRates = cached; return }

  try {
    const url = new URL('https://api.frankfurter.app/latest')
    url.searchParams.set('base', 'EUR')
    url.searchParams.set('symbols', 'USD,GBP,CHF,DKK')
    const data = await fetchJson<{ rates: Record<string, number> }>(url)
    if (!data.rates) return
    liveEurRates = {
      EUR: 1,
      USD: 1 / data.rates['USD'],
      GBP: 1 / data.rates['GBP'],
      CHF: 1 / data.rates['CHF'],
      DKK: 1 / data.rates['DKK'],
    }
    setCache('ecb_fx', liveEurRates, TTL.fxRates)
  } catch {}
}

export function toEur(amount: number, currency: CurrencyCode): number {
  return amount * liveEurRates[currency]
}

export function fromEur(amount: number, currency: CurrencyCode): number {
  return amount / liveEurRates[currency]
}

// ── Provider helpers ──────────────────────────────────────────────────────────

export function hasMinimumDataAccess(settings: AppSettings): boolean {
  return Boolean(settings.finnhubApiKey && settings.marketauxApiKey && settings.eulerpoolApiKey)
}

export function getProviderStatus(settings: AppSettings): Record<string, boolean> {
  return {
    Finnhub: Boolean(settings.finnhubApiKey),
    Marketaux: Boolean(settings.marketauxApiKey),
    Eulerpool: Boolean(settings.eulerpoolApiKey),
    'Yahoo Finance': true,
    'SEC EDGAR': Boolean(settings.secUserAgent),
    'Alpha Vantage': Boolean(settings.alphaVantageApiKey),
    FMP: Boolean(settings.fmpApiKey),
    EODHD: Boolean(settings.eodhdApiKey),
  }
}

export function mockCurrentPrice(stock: WatchlistItem): number {
  const base = seeded(stock.symbol, 42)
  const scale = stock.currency === 'DKK' ? 900 : stock.currency === 'GBP' ? 130 : 520
  return Number((18 + base * scale).toFixed(2))
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

// ── Live market data (scoring) ────────────────────────────────────────────────

export async function fetchLiveMarketData(stock: WatchlistItem, settings: AppSettings): Promise<LiveMarketData> {
  const calls =
    stock.region === 'US'
      ? [
          fetchYahooData(stock),                     // signals + price (fallback)
          fetchFinnhubData(stock, settings),          // overrides signals + price for US
          fetchMarketauxData(stock, settings),        // adds sentiment
          fetchSecEdgarInsider(stock, settings),      // adds insider
        ]
      : [
          fetchYahooData(stock),                     // signals + price (primary for EU)
          fetchEulerpoolData(stock, settings),        // may override price
          fetchMarketauxData(stock, settings),        // adds sentiment
        ]

  const results = await Promise.all(calls)
  return mergeLiveData(results)
}

// ── Yahoo Finance ─────────────────────────────────────────────────────────────

async function fetchYahooData(stock: WatchlistItem): Promise<LiveMarketData> {
  const cacheKey = `yahoo_signals_${stock.symbol}`
  const cached = getCache<LiveMarketData>(cacheKey)
  if (cached) return cached

  try {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(stock.symbol)}`)
    url.searchParams.set('interval', '1d')
    url.searchParams.set('range', '6mo')
    url.searchParams.set('includePrePost', 'false')

    const data = await fetchJson<YahooChartResponse>(url)
    const result = data.chart?.result?.[0]
    if (!result) return emptyLiveData()

    const rawCloses = result.indicators.adjclose?.[0]?.adjclose ?? result.indicators.quote[0].close ?? []
    const rawVolumes = result.indicators.quote[0].volume ?? []

    // Filter out null/NaN values (Yahoo returns null for non-trading days)
    const pairs = rawCloses
      .map((c, i) => ({ c, v: rawVolumes[i] ?? 0 }))
      .filter(({ c }) => c != null && Number.isFinite(c))
    const closes = pairs.map(({ c }) => c!)
    const volumes = pairs.map(({ v }) => v ?? 0)

    if (closes.length < 20) return emptyLiveData()

    const price = Number(closes.at(-1)!.toFixed(2))
    const signal = signalFromCandles(closes, volumes)
    const liveData: LiveMarketData = { price, signal, sources: ['Yahoo Finance'], warnings: [] }
    setCache(cacheKey, liveData, TTL.prices)
    return liveData
  } catch {
    return { signal: {}, sources: [], warnings: ['Yahoo Finance no disponible.'] }
  }
}

// ── Finnhub ───────────────────────────────────────────────────────────────────

async function fetchFinnhubData(stock: WatchlistItem, settings: AppSettings): Promise<LiveMarketData> {
  if (!settings.finnhubApiKey || stock.region !== 'US') return emptyLiveData()

  const cacheKey = `finnhub_${stock.symbol}`
  const cached = getCache<LiveMarketData>(cacheKey)
  if (cached) return cached

  const warnings: string[] = []
  const sources: string[] = []
  let price: number | undefined
  const signal: Partial<SignalScore> = {}

  try {
    const quoteUrl = new URL('https://finnhub.io/api/v1/quote')
    quoteUrl.searchParams.set('symbol', stock.symbol)
    quoteUrl.searchParams.set('token', settings.finnhubApiKey)
    const quote = await fetchJson<Record<string, number>>(quoteUrl)
    if (quote['c'] > 0) {
      price = Number(quote['c'].toFixed(2))
      sources.push('Finnhub quote')
    }
  } catch {
    warnings.push('Finnhub quote no disponible.')
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
    warnings.push('Finnhub historical no disponible.')
  }

  const liveData: LiveMarketData = { price, signal, sources, warnings }
  if (sources.length) setCache(cacheKey, liveData, TTL.prices)
  return liveData
}

// ── Marketaux ─────────────────────────────────────────────────────────────────

async function fetchMarketauxData(stock: WatchlistItem, settings: AppSettings): Promise<LiveMarketData> {
  if (!settings.marketauxApiKey) return emptyLiveData()

  const cacheKey = `marketaux_${stock.symbol}`
  const cached = getCache<LiveMarketData>(cacheKey)
  if (cached) return cached

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
      .flatMap((a) => a.entities ?? [])
      .filter((e) => e.symbol?.toUpperCase() === stock.symbol.toUpperCase())
      .map((e) => e.sentiment_score)
      .filter((s): s is number => typeof s === 'number')

    if (!scores.length) return emptyLiveData()

    const avg = scores.reduce((a, b) => a + b, 0) / scores.length
    const liveData: LiveMarketData = {
      signal: { sentiment: clamp((avg + 1) * 50) },
      sources: ['Marketaux sentiment'],
      warnings: [],
    }
    setCache(cacheKey, liveData, TTL.sentiment)
    return liveData
  } catch {
    return { signal: {}, sources: [], warnings: ['Marketaux no disponible.'] }
  }
}

// ── Eulerpool ─────────────────────────────────────────────────────────────────

async function fetchEulerpoolData(stock: WatchlistItem, settings: AppSettings): Promise<LiveMarketData> {
  if (!settings.eulerpoolApiKey) return emptyLiveData()

  const cacheKey = `eulerpool_${stock.symbol}`
  const cached = getCache<LiveMarketData>(cacheKey)
  if (cached) return cached

  try {
    const url = new URL(`https://api.eulerpool.com/api/1/equity/price/${encodeURIComponent(stock.symbol)}`)
    url.searchParams.set('token', settings.eulerpoolApiKey)
    const data = await fetchJson<Record<string, unknown>>(url)
    const price = firstNumber(data, ['price', 'close', 'last', 'current_price', 'currentPrice'])
    if (!price || price <= 0) return emptyLiveData()

    const liveData: LiveMarketData = { price: Number(price.toFixed(2)), signal: {}, sources: ['Eulerpool price'], warnings: [] }
    setCache(cacheKey, liveData, TTL.prices)
    return liveData
  } catch {
    return { signal: {}, sources: [], warnings: ['Eulerpool no disponible.'] }
  }
}

// ── SEC EDGAR Form 4 (insider activity) ──────────────────────────────────────

async function fetchSecEdgarInsider(stock: WatchlistItem, settings: AppSettings): Promise<LiveMarketData> {
  if (!settings.secUserAgent || stock.region !== 'US') return emptyLiveData()

  const cacheKey = `sec_${stock.symbol}`
  const cached = getCache<LiveMarketData>(cacheKey)
  if (cached) return cached

  try {
    const tickerMap = await fetchSecTickerMap(settings.secUserAgent)
    const cik = tickerMap[stock.symbol.toUpperCase()]
    if (!cik) return emptyLiveData()

    const paddedCik = String(cik).padStart(10, '0')
    const url = new URL(`https://data.sec.gov/submissions/CIK${paddedCik}.json`)
    const submissions = await fetchJson<SecSubmissions>(url, { 'User-Agent': settings.secUserAgent })

    const forms = submissions.filings.recent.form
    const dates = submissions.filings.recent.filingDate
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 90)

    const recentForm4 = forms.filter((f, i) => f === '4' && new Date(dates[i]) >= cutoff).length

    const insider =
      recentForm4 === 0 ? 35
      : recentForm4 <= 2 ? 52
      : recentForm4 <= 5 ? 67
      : 80

    const liveData: LiveMarketData = {
      signal: { insider },
      sources: ['SEC EDGAR Form 4'],
      warnings: [],
    }
    setCache(cacheKey, liveData, TTL.insider)
    return liveData
  } catch {
    return { signal: {}, sources: [], warnings: ['SEC EDGAR no disponible.'] }
  }
}

async function fetchSecTickerMap(userAgent: string): Promise<Record<string, number>> {
  const cached = getCache<Record<string, number>>('sec_tickers')
  if (cached) return cached

  const url = new URL('https://www.sec.gov/files/company_tickers.json')
  const data = await fetchJson<Record<string, { cik_str: number; ticker: string }>>(url, {
    'User-Agent': userAgent,
  })

  const map: Record<string, number> = {}
  for (const entry of Object.values(data)) {
    map[entry.ticker.toUpperCase()] = entry.cik_str
  }
  setCache('sec_tickers', map, TTL.secTickers)
  return map
}

// ── Price history (modal chart) ───────────────────────────────────────────────

export async function fetchPriceHistory(
  stock: WatchlistItem,
  settings: AppSettings,
  days: 30 | 60,
): Promise<PriceHistory> {
  const threshold = Math.floor(days * 0.6)

  // Yahoo Finance — free, works for all 22 stocks
  try {
    const points = await fetchYahooHistory(stock.symbol, days)
    if (points.length >= threshold) return { points, source: 'Yahoo Finance' }
  } catch {}

  // Finnhub candles — US only
  if (settings.finnhubApiKey && stock.region === 'US') {
    try {
      const points = await fetchFinnhubHistory(stock, settings, days)
      if (points.length >= threshold) return { points, source: 'Finnhub' }
    } catch {}
  }

  if (settings.eodhdApiKey) {
    try {
      const points = await fetchEodhdHistory(stock, settings, days)
      if (points.length >= threshold) return { points, source: 'EODHD' }
    } catch {}
  }

  if (settings.alphaVantageApiKey && stock.region === 'US') {
    try {
      const points = await fetchAlphaVantageHistory(stock, settings, days)
      if (points.length >= threshold) return { points, source: 'Alpha Vantage' }
    } catch {}
  }

  if (settings.fmpApiKey) {
    try {
      const points = await fetchFmpHistory(stock, settings, days)
      if (points.length >= threshold) return { points, source: 'FMP' }
    } catch {}
  }

  return { points: mockPriceHistory(stock, days), source: 'Estimado (sin API)' }
}

async function fetchYahooHistory(symbol: string, days: number): Promise<PricePoint[]> {
  const cacheKey = `yahoo_hist_${symbol}_${days}`
  const cached = getCache<PricePoint[]>(cacheKey)
  if (cached) return cached

  const range = days <= 30 ? '1mo' : '3mo'
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`)
  url.searchParams.set('interval', '1d')
  url.searchParams.set('range', range)
  url.searchParams.set('includePrePost', 'false')

  const data = await fetchJson<YahooChartResponse>(url)
  const result = data.chart?.result?.[0]
  if (!result) return []

  const timestamps = result.timestamp
  const closes = result.indicators.adjclose?.[0]?.adjclose ?? result.indicators.quote[0].close ?? []

  const points: PricePoint[] = timestamps
    .map((ts, i) => ({
      date: new Date(ts * 1000).toLocaleDateString('es-ES', { month: 'short', day: 'numeric' }),
      price: Number((closes[i] ?? 0).toFixed(2)),
    }))
    .filter((p) => p.price > 0)
    .slice(-days)

  if (points.length) setCache(cacheKey, points, TTL.prices)
  return points
}

async function fetchFinnhubHistory(stock: WatchlistItem, settings: AppSettings, days: number): Promise<PricePoint[]> {
  const now = Math.floor(Date.now() / 1000)
  const from = now - (days + 14) * 24 * 60 * 60
  const url = new URL('https://finnhub.io/api/v1/stock/candle')
  url.searchParams.set('symbol', stock.symbol)
  url.searchParams.set('resolution', 'D')
  url.searchParams.set('from', String(from))
  url.searchParams.set('to', String(now))
  url.searchParams.set('token', settings.finnhubApiKey)

  const candles = await fetchJson<{ s: string; c?: number[]; t?: number[] }>(url)
  if (candles.s !== 'ok' || !candles.c?.length || !candles.t?.length) return []

  const count = Math.min(days, candles.c.length)
  return candles.c.slice(-count).map((price, i) => ({
    date: new Date(candles.t![candles.t!.length - count + i] * 1000).toLocaleDateString('es-ES', { month: 'short', day: 'numeric' }),
    price: Number(price.toFixed(2)),
  }))
}

async function fetchAlphaVantageHistory(stock: WatchlistItem, settings: AppSettings, days: number): Promise<PricePoint[]> {
  const url = new URL('https://www.alphavantage.co/query')
  url.searchParams.set('function', 'TIME_SERIES_DAILY')
  url.searchParams.set('symbol', stock.symbol)
  url.searchParams.set('outputsize', days > 30 ? 'full' : 'compact')
  url.searchParams.set('apikey', settings.alphaVantageApiKey)

  const data = await fetchJson<Record<string, unknown>>(url)
  const series = data['Time Series (Daily)'] as Record<string, Record<string, string>> | undefined
  if (!series) return []

  return Object.entries(series)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-days)
    .map(([dateStr, values]) => ({
      date: new Date(dateStr).toLocaleDateString('es-ES', { month: 'short', day: 'numeric' }),
      price: Number(parseFloat(values['4. close']).toFixed(2)),
    }))
}

async function fetchEodhdHistory(stock: WatchlistItem, settings: AppSettings, days: number): Promise<PricePoint[]> {
  const from = new Date()
  from.setDate(from.getDate() - days - 5)
  const url = new URL(`https://eodhd.com/api/eod/${encodeURIComponent(stock.symbol)}`)
  url.searchParams.set('api_token', settings.eodhdApiKey)
  url.searchParams.set('from', from.toISOString().slice(0, 10))
  url.searchParams.set('fmt', 'json')

  const data = await fetchJson<Array<{ date: string; close: number }>>(url)
  if (!Array.isArray(data)) return []

  return data.slice(-days).map((item) => ({
    date: new Date(item.date).toLocaleDateString('es-ES', { month: 'short', day: 'numeric' }),
    price: Number(item.close.toFixed(2)),
  }))
}

async function fetchFmpHistory(stock: WatchlistItem, settings: AppSettings, days: number): Promise<PricePoint[]> {
  const to = new Date().toISOString().slice(0, 10)
  const from = new Date()
  from.setDate(from.getDate() - days - 5)

  const url = new URL(`https://financialmodelingprep.com/api/v3/historical-price-full/${encodeURIComponent(stock.symbol)}`)
  url.searchParams.set('from', from.toISOString().slice(0, 10))
  url.searchParams.set('to', to)
  url.searchParams.set('apikey', settings.fmpApiKey)

  const data = await fetchJson<{ historical?: Array<{ date: string; close: number }> }>(url)
  if (!data.historical?.length) return []

  return data.historical
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-days)
    .map((item) => ({
      date: new Date(item.date).toLocaleDateString('es-ES', { month: 'short', day: 'numeric' }),
      price: Number(item.close.toFixed(2)),
    }))
}

function mockPriceHistory(stock: WatchlistItem, days: number): PricePoint[] {
  const endPrice = mockCurrentPrice(stock)
  const today = new Date()

  const tradingDays: Date[] = []
  for (let offset = 0; tradingDays.length < days; offset++) {
    const d = new Date(today)
    d.setDate(today.getDate() - offset)
    if (d.getDay() !== 0 && d.getDay() !== 6) tradingDays.push(new Date(d))
    if (offset > days * 3) break
  }

  const returns = tradingDays.map((_, i) => (seeded(stock.symbol, i * 13 + 7) - 0.5) * 0.038)
  const totalCompound = returns.reduce((acc, r) => acc * (1 + r), 1)
  const startPrice = endPrice / totalCompound

  let price = startPrice
  return tradingDays
    .reverse()
    .map((date, i) => {
      price = i === 0 ? startPrice : price * (1 + returns[tradingDays.length - 1 - i])
      return {
        date: date.toLocaleDateString('es-ES', { month: 'short', day: 'numeric' }),
        price: Number(Math.max(price, 0.01).toFixed(2)),
      }
    })
}

// ── Technical indicators ──────────────────────────────────────────────────────

function computeRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  const slice = closes.slice(-(period + 1))
  let gains = 0
  let losses = 0
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1]
    if (diff > 0) gains += diff
    else losses -= diff
  }
  if (losses === 0) return 100
  const rs = gains / losses
  return 100 - 100 / (1 + rs)
}

function rsiToSignal(rsi: number): number {
  // RSI 0→85, RSI 50→50, RSI 100→15 (linear inversion)
  return clamp(85 - rsi * 0.7)
}

function computeEma(values: number[], period: number): number[] {
  if (values.length < period) return []
  const k = 2 / (period + 1)
  const emas: number[] = []
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  emas.push(ema)
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k)
    emas.push(ema)
  }
  return emas
}

function macdToTrendSignal(closes: number[]): number {
  if (closes.length < 35) return 50
  const ema12 = computeEma(closes, 12)
  const ema26 = computeEma(closes, 26)
  if (!ema12.length || !ema26.length) return 50

  const offset = ema12.length - ema26.length
  const macdLine = ema26.map((e26, i) => ema12[i + offset] - e26)
  const signalLine = computeEma(macdLine, 9)
  if (!signalLine.length) return 50

  const macdVal = macdLine.at(-1)!
  const sigVal = signalLine.at(-1)!
  const lastPrice = closes.at(-1) ?? 1

  // Express crossover as % of price and scale to [0,100]
  const crossoverPct = ((macdVal - sigVal) / lastPrice) * 100
  const aboveZero = macdVal > 0 ? 8 : -8

  return clamp(50 + crossoverPct * 15 + aboveZero)
}

function signalFromCandles(closes: number[], volumes: number[]): Partial<SignalScore> {
  const last = closes.at(-1) ?? 0
  const close7 = closes.at(-8) ?? closes[0]
  const close30 = closes.at(-31) ?? closes[0]
  const close90 = closes.at(-91) ?? closes[0]

  const momentumReturn = (pct(last, close7) * 0.35 + pct(last, close30) * 0.45 + pct(last, close90) * 0.2) * 100
  const rawMomentum = clamp(50 + momentumReturn * 1.35)

  const sma20 = average(closes.slice(-20))
  const sma50 = average(closes.slice(-50))
  const smaTrend = clamp(50 + pct(last, sma20) * 230 + pct(sma20, sma50) * 180)

  const recentVolumes = volumes.slice(-10)
  const baselineVolumes = volumes.slice(-60, -10)
  const dailyReturns = closes
    .slice(-45)
    .map((c, i, arr) => (i ? pct(c, arr[i - 1]) : 0))
    .slice(1)
  const volatility = stdev(dailyReturns)

  // Blend traditional signals with RSI and MACD
  const rsi = computeRsi(closes)
  const rsiSignal = rsiToSignal(rsi)
  const macdSignal = macdToTrendSignal(closes)

  return {
    momentum: clamp(rawMomentum * 0.6 + rsiSignal * 0.4),
    trend: clamp(smaTrend * 0.6 + macdSignal * 0.4),
    stability: clamp(86 - volatility * 900),
    volume: clamp(50 + pct(average(recentVolumes), average(baselineVolumes)) * 120),
    risk: clamp(22 + volatility * 900),
  }
}

// ── Shared fetch / merge ──────────────────────────────────────────────────────

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

async function fetchJson<T>(url: URL, extraHeaders: Record<string, string> = {}): Promise<T> {
  if ('__TAURI_INTERNALS__' in window) {
    return invoke<T>('http_get_json', {
      url: url.toString(),
      headers: Object.keys(extraHeaders).length ? extraHeaders : undefined,
    })
  }

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 9000)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: extraHeaders })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as T
  } finally {
    window.clearTimeout(timeout)
  }
}

// ── Math utilities ────────────────────────────────────────────────────────────

function pct(current: number, previous: number): number {
  if (!previous) return 0
  return (current - previous) / previous
}

function average(values: number[]): number {
  const valid = values.filter((v) => Number.isFinite(v) && v > 0)
  if (!valid.length) return 0
  return valid.reduce((a, b) => a + b, 0) / valid.length
}

function stdev(values: number[]): number {
  if (!values.length) return 0
  const avg = values.reduce((a, b) => a + b, 0) / values.length
  return Math.sqrt(values.reduce((a, v) => a + (v - avg) ** 2, 0) / values.length)
}

function firstNumber(data: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'number') return value
    if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) return Number(value)
  }
}

function seeded(value: string, salt: number): number {
  let hash = salt
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) % 9973
  return (hash % 1000) / 1000
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Number(value.toFixed(1))))
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface MarketauxArticle {
  entities?: Array<{ symbol?: string; sentiment_score?: number }>
}

interface YahooChartResponse {
  chart: {
    result?: Array<{
      timestamp: number[]
      indicators: {
        quote: Array<{
          close: (number | null)[]
          volume: (number | null)[]
        }>
        adjclose?: Array<{ adjclose: (number | null)[] }>
      }
    }>
  }
}

interface SecSubmissions {
  filings: {
    recent: {
      form: string[]
      filingDate: string[]
    }
  }
}
