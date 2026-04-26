export const TTL = {
  prices: 4 * 60 * 60 * 1000,
  sentiment: 60 * 60 * 1000,
  insider: 6 * 60 * 60 * 1000,
  fxRates: 24 * 60 * 60 * 1000,
  secTickers: 24 * 60 * 60 * 1000,
} as const

interface CacheEntry<T> {
  data: T
  ts: number
  ttl: number
}

export function getCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`ib_${key}`)
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry<T>
    if (Date.now() - entry.ts > entry.ttl) {
      localStorage.removeItem(`ib_${key}`)
      return null
    }
    return entry.data
  } catch {
    return null
  }
}

export function setCache<T>(key: string, data: T, ttl: number): void {
  try {
    const entry: CacheEntry<T> = { data, ts: Date.now(), ttl }
    localStorage.setItem(`ib_${key}`, JSON.stringify(entry))
  } catch {}
}
