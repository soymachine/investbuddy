export type MarketRegion = 'US' | 'EU'

export type CurrencyCode = 'EUR' | 'USD' | 'GBP' | 'CHF' | 'DKK'

export type ProviderName =
  | 'Finnhub'
  | 'SEC EDGAR'
  | 'Marketaux'
  | 'Eulerpool'
  | 'ECB'
  | 'Stooq'

export interface WatchlistItem {
  symbol: string
  name: string
  region: MarketRegion
  exchange: string
  currency: CurrencyCode
  sector: string
  providers: ProviderName[]
}

export interface SignalScore {
  momentum: number
  trend: number
  stability: number
  volume: number
  sentiment: number
  insider: number | null
  risk: number
}

export interface Recommendation {
  rank: number
  stock: WatchlistItem
  score: number
  price: number
  currency: CurrencyCode
  allocationEur: number
  signal: SignalScore
  thesis: string[]
  warnings: string[]
  dataSources: string[]
}

export interface Holding {
  id: string
  symbol: string
  name: string
  investedEur: number
  buyPrice: number
  currentPrice: number
  currency: CurrencyCode
  units: number
  boughtAt: string
}

export interface AppSettings {
  finnhubApiKey: string
  marketauxApiKey: string
  eulerpoolApiKey: string
  alphaVantageApiKey: string
  fmpApiKey: string
  eodhdApiKey: string
  secUserAgent: string
  riskProfile: 'balanced' | 'bold' | 'defensive'
}
