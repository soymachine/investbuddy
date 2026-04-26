import { WATCHLIST } from '../data/watchlist'
import type { AppSettings, Recommendation, SignalScore, WatchlistItem } from '../types'
import { fetchLiveMarketData, fromEur, mockCurrentPrice, mockSignal } from './marketData'
import type { LiveMarketData } from './marketData'

const profileRiskPenalty = {
  defensive: 0.2,
  balanced: 0.14,
  bold: 0.08,
}

export function buildRecommendations(settings: AppSettings): Recommendation[] {
  return WATCHLIST.map((stock) => scoreStock(stock, settings))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((recommendation, index) => ({ ...recommendation, rank: index + 1 }))
}

export async function buildLiveRecommendations(settings: AppSettings): Promise<Recommendation[]> {
  const scored = await Promise.all(
    WATCHLIST.map(async (stock) => {
      const liveData = await fetchLiveMarketData(stock, settings)
      return scoreStock(stock, settings, liveData)
    }),
  )

  return scored
    .sort((a, b) => b.score - a.score)
    .map((recommendation, index) => ({ ...recommendation, rank: index + 1 }))
}

export function scoreStock(stock: WatchlistItem, settings: AppSettings, liveData?: LiveMarketData): Recommendation {
  const signal = { ...mockSignal(stock), ...liveData?.signal }
  const insider = signal.insider ?? 50
  const missingInsiderPenalty = signal.insider === null ? 3 : 0
  const score =
    signal.momentum * 0.3 +
    signal.trend * 0.22 +
    signal.stability * 0.16 +
    signal.volume * 0.12 +
    signal.sentiment * 0.13 +
    insider * 0.12 -
    signal.risk * profileRiskPenalty[settings.riskProfile] -
    missingInsiderPenalty

  const price = liveData?.price ?? mockCurrentPrice(stock)
  const dataSources = liveData?.sources.length ? liveData.sources : ['Local fallback model']

  return {
    rank: 0,
    stock,
    score: Math.max(0, Math.min(100, Number(score.toFixed(1)))),
    price,
    currency: stock.currency,
    allocationEur: 100,
    signal,
    thesis: buildThesis(stock, signal, dataSources),
    warnings: [...buildWarnings(stock, signal), ...(liveData?.warnings ?? [])],
    dataSources,
  }
}

function buildThesis(stock: WatchlistItem, signal: SignalScore, dataSources: string[]): string[] {
  const thesis = [
    `Momentum ${signal.momentum.toFixed(0)}/100 con tendencia ${signal.trend.toFixed(0)}/100.`,
    `Volumen relativo ${signal.volume.toFixed(0)}/100 y sentimiento ${signal.sentiment.toFixed(0)}/100.`,
    `Fuentes activas: ${dataSources.join(', ')}.`,
    `Asignacion aproximada: ${stock.currency} ${fromEur(100, stock.currency).toFixed(2)} antes de comisiones externas.`,
  ]

  if (signal.insider !== null) {
    thesis.push(`Senal insider publica EEUU ${signal.insider.toFixed(0)}/100 desde filings Form 4.`)
  }

  return thesis
}

function buildWarnings(stock: WatchlistItem, signal: SignalScore): string[] {
  const warnings = []

  if (stock.region === 'EU') {
    warnings.push('Insider europeo pendiente de conectar por regulador; peso recalibrado.')
  }

  if (signal.risk > 68) {
    warnings.push('Riesgo/volatilidad elevado: revisar antes de ejecutar en Trade Republic.')
  }

  return warnings.length ? warnings : ['No hay alertas criticas en el modelo MVP.']
}
