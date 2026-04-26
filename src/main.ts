import './style.css'
import { WATCHLIST } from './data/watchlist'
import {
  getProviderStatus,
  hasMinimumDataAccess,
  mockCurrentPrice,
  toEur,
  fetchPriceHistory,
  refreshFxRates,
} from './services/marketData'
import type { PricePoint } from './services/marketData'
import { buildLiveRecommendations, buildRecommendations, scoreStock } from './services/scoring'
import { loadHoldings, loadSettings, saveHoldings, saveSettings } from './services/storage'
import type { AppSettings, Holding, Recommendation, WatchlistItem } from './types'

const APP_VERSION = '0.4.0'

type ViewName = 'dashboard' | 'watchlist' | 'portfolio' | 'settings'

interface AppState {
  view: ViewName
  settings: AppSettings
  holdings: Holding[]
  recommendations: Recommendation[]
  allRecommendations: Recommendation[]
  lastUpdatedAt: number | null
  isRefreshing: boolean
  watchlistSortByScore: boolean
  selectedStock: WatchlistItem | null
  stockHistory: PricePoint[] | null
  historyDays: 30 | 60
  historyLoading: boolean
  historySource: string
}

const state: AppState = {
  view: 'dashboard',
  settings: loadSettings(),
  holdings: loadHoldings(),
  recommendations: [],
  allRecommendations: [],
  lastUpdatedAt: null,
  isRefreshing: false,
  watchlistSortByScore: false,
  selectedStock: null,
  stockHistory: null,
  historyDays: 30,
  historyLoading: false,
  historySource: '',
}

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('Missing app root')
}

refreshFxRates() // fire-and-forget: actualiza tipos de cambio ECB en background
render()

function render(): void {
  app.innerHTML = `
    <div class="app-shell">
      ${renderHeader()}
      <main class="workspace">
        ${state.view === 'dashboard' ? renderHero() : renderCompactInvest()}
        ${renderView()}
      </main>
      ${state.selectedStock ? renderStockModal() : ''}
    </div>
  `

  bindEvents()
}

function renderHeader(): string {
  const access = hasMinimumDataAccess(state.settings) ? 'DATA READY' : 'KEYS PENDING'
  const refreshLabel = state.isRefreshing ? 'CARGANDO' : 'ACTUALIZAR'
  const updatedText = state.isRefreshing
    ? 'actualizando...'
    : state.lastUpdatedAt
      ? relativeTime(state.lastUpdatedAt)
      : 'sin datos'

  return `
    <header class="topbar" aria-label="InvestBuddy navigation">
      <button class="brand" data-view="dashboard" type="button" aria-label="Volver al dashboard">
        <span class="brand-mark" aria-hidden="true"></span>
        <span>INVESTBUDDY</span>
      </button>
      <nav class="nav-links" aria-label="Pantallas principales">
        ${navButton('dashboard', 'Dashboard')}
        ${navButton('watchlist', 'Watchlist')}
        ${navButton('portfolio', 'Portfolio')}
        ${navButton('settings', 'Settings')}
      </nav>
      <div class="topbar-meta">
        <button class="refresh-btn" id="refresh-btn" type="button" ${state.isRefreshing ? 'disabled' : ''} aria-label="Actualizar datos de mercado">
          <span>${refreshLabel}</span>
          <small>${updatedText}</small>
        </button>
        <div class="system-pill">${access}</div>
        <div class="version-pill">v${APP_VERSION}</div>
      </div>
    </header>
  `
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'hace un momento'
  if (mins < 60) return `hace ${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `hace ${hours}h`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'hace 1 día'
  if (days < 7) return `hace ${days} días`
  const weeks = Math.floor(days / 7)
  if (weeks === 1) return 'hace 1 semana'
  return `hace ${weeks} semanas`
}

function navButton(view: ViewName, label: string): string {
  const active = state.view === view ? 'is-active' : ''
  return `<button class="nav-link ${active}" data-view="${view}" type="button">${label}</button>`
}

function renderHero(): string {
  const subtitle = state.lastUpdatedAt
    ? `Ultima actualizacion: ${relativeTime(state.lastUpdatedAt)}`
    : 'Usa ACTUALIZAR en la barra superior para puntuar la watchlist con el modelo MVP.'

  return `
    <section class="hero-panel">
      <div class="hero-copy">
        <p class="eyebrow">/ CAPITAL DECISION SYSTEM</p>
        <h1>NO RUIDO,<br>SOLO MOVIMIENTO.</h1>
        <p class="hero-subtitle">${subtitle}</p>
      </div>
      <button class="invest-button" id="invest-button" type="button">
        <span>INVERTIR</span>
        <small>100 EUR / TOP 3</small>
      </button>
      <div class="orb" aria-hidden="true"></div>
    </section>
  `
}

function renderCompactInvest(): string {
  const subtitle = state.lastUpdatedAt
    ? `Ultima actualizacion: ${relativeTime(state.lastUpdatedAt)}`
    : 'Analiza la watchlist completa'

  return `
    <div class="compact-invest">
      <div>
        <p class="eyebrow">/ CAPITAL DECISION SYSTEM</p>
        <p class="compact-invest-sub">${subtitle}</p>
      </div>
      <button class="invest-button-compact" id="invest-button" type="button">
        <span>INVERTIR</span>
        <small>100 EUR / TOP 3</small>
      </button>
    </div>
  `
}

function renderView(): string {
  if (state.view === 'watchlist') return renderWatchlist()
  if (state.view === 'portfolio') return renderPortfolio()
  if (state.view === 'settings') return renderSettings()
  return renderDashboard()
}

function renderDashboard(): string {
  const holdingsValue = state.holdings.reduce((total, holding) => {
    return total + holding.units * toEur(holding.currentPrice, holding.currency)
  }, 0)
  const invested = state.holdings.reduce((total, holding) => total + holding.investedEur, 0)
  const pnl = holdingsValue - invested
  const recommendations = state.recommendations.length ? state.recommendations : buildRecommendations(state.settings)

  return `
    <section class="bento-grid dashboard-grid">
      <article class="bento-card span-4">
        <span class="card-kicker">Portfolio</span>
        <strong class="metric">${formatEur(holdingsValue)}</strong>
        <p class="muted">Invertido ${formatEur(invested)} · P/L ${formatSignedEur(pnl)}</p>
      </article>
      <article class="bento-card span-4">
        <span class="card-kicker">Mercado</span>
        <strong class="metric">${marketPulse(recommendations)}</strong>
        <p class="muted">Modelo ponderado por tendencia, sentimiento, volumen y riesgo.</p>
      </article>
      <article class="bento-card span-4">
        <span class="card-kicker">Cobertura</span>
        <strong class="metric">${WATCHLIST.length}</strong>
        <p class="muted">10 EEUU · 12 Europa · divisa base EUR.</p>
      </article>
      <article class="bento-card span-12 recommendations-panel">
        <div class="section-heading">
          <p class="eyebrow">/ TOP SIGNALS</p>
          <h2>Alternativas para los proximos 100 EUR</h2>
        </div>
        <div class="recommendation-list">
          ${recommendations.map(renderRecommendation).join('')}
        </div>
      </article>
    </section>
  `
}

function renderRecommendation(recommendation: Recommendation): string {
  return `
    <article class="recommendation-card">
      <div class="rank">0${recommendation.rank || 1}</div>
      <div>
        <div class="recommendation-title">
          <h3>${recommendation.stock.symbol}</h3>
          <span>${recommendation.stock.name}</span>
        </div>
        <p class="muted">${recommendation.thesis[0]}</p>
        <p class="data-sources">${recommendation.dataSources.join(' / ')}</p>
      </div>
      <div class="score-block">
        <span>${recommendation.score.toFixed(1)}</span>
        <small>SCORE</small>
      </div>
      <button class="ghost-button" data-register="${recommendation.stock.symbol}" type="button">Registrar</button>
    </article>
  `
}

function renderWatchlist(): string {
  const stocks = state.watchlistSortByScore
    ? [...WATCHLIST].sort((a, b) => {
        const scoreA = (state.allRecommendations.find((r) => r.stock.symbol === a.symbol) ?? scoreStock(a, state.settings)).score
        const scoreB = (state.allRecommendations.find((r) => r.stock.symbol === b.symbol) ?? scoreStock(b, state.settings)).score
        return scoreB - scoreA
      })
    : WATCHLIST

  return `
    <section class="bento-grid">
      <article class="bento-card span-12">
        <div class="watchlist-toolbar">
          <p class="eyebrow">/ FIXED UNIVERSE</p>
          <button class="sort-score-btn ${state.watchlistSortByScore ? 'is-active' : ''}" id="sort-score-btn" type="button">
            SCORE ${state.watchlistSortByScore ? '↓' : '—'}
          </button>
        </div>
        <p class="watchlist-hint">Pulsa sobre cualquier accion para ver su evolucion de precio.</p>
        <div class="stock-table" role="table" aria-label="Watchlist de acciones">
          ${stocks.map(renderStockRow).join('')}
        </div>
      </article>
    </section>
  `
}

function renderStockRow(stock: WatchlistItem): string {
  const recommendation =
    state.allRecommendations.find((r) => r.stock.symbol === stock.symbol) ??
    scoreStock(stock, state.settings)
  const providers = stock.providers.map((provider) => `<span>${provider}</span>`).join('')

  return `
    <div class="stock-row" role="row" data-symbol="${stock.symbol}" tabindex="0" aria-label="Ver evolucion de ${stock.name}">
      <div>
        <strong>${stock.symbol}</strong>
        <small>${stock.name}</small>
      </div>
      <span>${stock.region}</span>
      <span>${stock.exchange}</span>
      <span>${stock.sector}</span>
      <span>${stock.currency} ${mockCurrentPrice(stock).toFixed(2)}</span>
      <span class="mini-score">${recommendation.score.toFixed(1)}</span>
      <div class="provider-stack">${providers}</div>
    </div>
  `
}

function renderStockModal(): string {
  const stock = state.selectedStock!
  const recommendation =
    state.allRecommendations.find((r) => r.stock.symbol === stock.symbol) ??
    scoreStock(stock, state.settings)
  const chartContent = state.historyLoading
    ? '<div class="chart-loading">CARGANDO DATOS...</div>'
    : state.stockHistory && state.stockHistory.length > 1
      ? renderPriceChart(state.stockHistory, stock)
      : '<div class="chart-loading">SIN DATOS DISPONIBLES</div>'

  return `
    <div class="modal-overlay" id="stock-modal" role="dialog" aria-modal="true" aria-label="Evolucion de ${stock.symbol}">
      <div class="modal-panel">
        <div class="modal-header">
          <div>
            <p class="eyebrow">/ EVOLUCION DE PRECIO</p>
            <h2 class="modal-title">${stock.symbol} <span>${stock.name}</span></h2>
          </div>
          <button class="modal-close" id="modal-close" type="button" aria-label="Cerrar">&#x2715;</button>
        </div>
        <div class="period-toggle">
          <button class="period-btn ${state.historyDays === 30 ? 'is-active' : ''}" data-days="30" type="button">30 DIAS</button>
          <button class="period-btn ${state.historyDays === 60 ? 'is-active' : ''}" data-days="60" type="button">60 DIAS</button>
        </div>
        <div class="chart-area">
          ${chartContent}
        </div>
        ${!state.historyLoading && state.stockHistory?.length ? renderHistoryStats(state.stockHistory, stock) : ''}
        ${renderScoreBreakdown(recommendation)}
      </div>
    </div>
  `
}

function renderPriceChart(history: PricePoint[], stock: WatchlistItem): string {
  const W = 580
  const H = 200
  const pad = { top: 14, right: 16, bottom: 30, left: 58 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom

  const prices = history.map((p) => p.price)
  const rawMin = Math.min(...prices)
  const rawMax = Math.max(...prices)
  const spread = rawMax - rawMin || rawMax * 0.01
  const minP = rawMin - spread * 0.08
  const maxP = rawMax + spread * 0.08

  const xScale = (i: number) => pad.left + (i / (history.length - 1)) * plotW
  const yScale = (p: number) => pad.top + plotH - ((p - minP) / (maxP - minP)) * plotH

  const pathData = history
    .map((point, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(point.price).toFixed(1)}`)
    .join(' ')

  const bottomY = pad.top + plotH
  const areaPath = `${pathData} L${xScale(history.length - 1).toFixed(1)},${bottomY} L${xScale(0).toFixed(1)},${bottomY} Z`

  const isUp = prices[prices.length - 1] >= prices[0]
  const lineColor = isUp ? 'var(--positive)' : 'var(--danger)'

  const xLabelCount = 5
  const xLabels = Array.from({ length: xLabelCount }, (_, i) => {
    const idx = Math.round((i * (history.length - 1)) / (xLabelCount - 1))
    return `<text x="${xScale(idx).toFixed(1)}" y="${H - 6}" fill="var(--text-muted)" font-size="9" text-anchor="middle">${history[idx].date}</text>`
  }).join('')

  const yLabelCount = 4
  const yLabels = Array.from({ length: yLabelCount }, (_, i) => {
    const p = minP + ((maxP - minP) * i) / (yLabelCount - 1)
    const y = yScale(p)
    return `<text x="${pad.left - 5}" y="${(y + 4).toFixed(1)}" fill="var(--text-muted)" font-size="9" text-anchor="end">${p.toFixed(stock.currency === 'DKK' ? 0 : 1)}</text>`
  }).join('')

  const gridLines = Array.from({ length: yLabelCount }, (_, i) => {
    const p = minP + ((maxP - minP) * i) / (yLabelCount - 1)
    const y = yScale(p).toFixed(1)
    return `<line x1="${pad.left}" y1="${y}" x2="${pad.left + plotW}" y2="${y}" stroke="rgba(255,230,0,0.06)" stroke-width="1"/>`
  }).join('')

  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:200px;display:block" aria-hidden="true">
      <defs>
        <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${lineColor}" stop-opacity="0.2"/>
          <stop offset="100%" stop-color="${lineColor}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      ${gridLines}
      <path d="${areaPath}" fill="url(#area-grad)" stroke="none"/>
      <path d="${pathData}" fill="none" stroke="${lineColor}" stroke-width="1.6" stroke-linejoin="round"/>
      ${xLabels}
      ${yLabels}
    </svg>
  `
}

function renderHistoryStats(history: PricePoint[], stock: WatchlistItem): string {
  const first = history[0].price
  const last = history[history.length - 1].price
  const change = last - first
  const changePct = first > 0 ? (change / first) * 100 : 0
  const min = Math.min(...history.map((p) => p.price))
  const max = Math.max(...history.map((p) => p.price))
  const isUp = change >= 0

  return `
    <div class="history-stats">
      <div class="stat-item">
        <span class="stat-value ${isUp ? 'positive' : 'negative'}">${isUp ? '+' : ''}${changePct.toFixed(2)}%</span>
        <small>VARIACION ${state.historyDays}D</small>
      </div>
      <div class="stat-item">
        <span class="stat-value">${stock.currency} ${last.toFixed(2)}</span>
        <small>ULTIMO PRECIO</small>
      </div>
      <div class="stat-item">
        <span class="stat-value">${stock.currency} ${min.toFixed(2)}</span>
        <small>MINIMO</small>
      </div>
      <div class="stat-item">
        <span class="stat-value">${stock.currency} ${max.toFixed(2)}</span>
        <small>MAXIMO</small>
      </div>
      ${state.historySource ? `<div class="stat-item"><span class="stat-value stat-source-val">${state.historySource}</span><small>FUENTE</small></div>` : ''}
    </div>
  `
}

function renderScoreBreakdown(rec: Recommendation): string {
  const signals: Array<{ label: string; value: number; inverted?: boolean }> = [
    { label: 'Momentum', value: rec.signal.momentum },
    { label: 'Tendencia', value: rec.signal.trend },
    { label: 'Estabilidad', value: rec.signal.stability },
    { label: 'Volumen', value: rec.signal.volume },
    { label: 'Sentimiento', value: rec.signal.sentiment },
    ...(rec.signal.insider !== null ? [{ label: 'Insider', value: rec.signal.insider }] : []),
    { label: 'Riesgo', value: rec.signal.risk, inverted: true },
  ]

  const bars = signals
    .map(({ label, value, inverted }) => {
      const barWidth = inverted ? 100 - value : value
      const color =
        inverted
          ? value > 68 ? 'var(--danger)' : 'var(--positive)'
          : value >= 70 ? 'var(--positive)' : value >= 45 ? 'var(--yellow)' : 'var(--danger)'
      return `
        <div class="signal-row">
          <span class="signal-label">${label}</span>
          <div class="signal-track">
            <div class="signal-fill" style="width:${barWidth.toFixed(0)}%;background:${color}"></div>
          </div>
          <span class="signal-val">${value.toFixed(0)}</span>
        </div>`
    })
    .join('')

  const warningHtml = rec.warnings.some((w) => !w.startsWith('No hay'))
    ? `<p class="breakdown-warnings">${rec.warnings.filter((w) => !w.startsWith('No hay')).join(' · ')}</p>`
    : ''

  return `
    <div class="score-breakdown">
      <div class="score-breakdown-header">
        <p class="eyebrow">/ SCORE BREAKDOWN</p>
        <span class="breakdown-score">${rec.score.toFixed(1)}<small>/ 100</small></span>
      </div>
      <div class="signal-bars">${bars}</div>
      <p class="data-sources">${rec.dataSources.join(' / ')}</p>
      ${warningHtml}
    </div>
  `
}

function renderPortfolio(): string {
  const rows = state.holdings.length
    ? state.holdings.map(renderHolding).join('')
    : '<div class="empty-state">Todavia no hay compras registradas. Usa INVERTIR y pulsa Registrar.</div>'

  return `
    <section class="bento-grid">
      <article class="bento-card span-12">
        <div class="section-heading">
          <p class="eyebrow">/ MANUAL LEDGER</p>
          <h2>Compras registradas fuera de Trade Republic</h2>
        </div>
        <div class="holding-list">${rows}</div>
      </article>
    </section>
  `
}

function renderHolding(holding: Holding): string {
  const currentValue = holding.units * toEur(holding.currentPrice, holding.currency)
  const pnl = currentValue - holding.investedEur

  return `
    <article class="holding-card">
      <div>
        <h3>${holding.symbol}</h3>
        <p class="muted">${holding.name} · ${holding.boughtAt}</p>
      </div>
      <span>${formatEur(holding.investedEur)}</span>
      <span>${formatEur(currentValue)}</span>
      <span class="${pnl >= 0 ? 'positive' : 'negative'}">${formatSignedEur(pnl)}</span>
      <button class="ghost-button danger" data-delete-holding="${holding.id}" type="button">Eliminar</button>
    </article>
  `
}

function renderSettings(): string {
  const providerStatus = getProviderStatus(state.settings)
  const statusItems = Object.entries(providerStatus)
    .map(([provider, enabled]) => `<span class="status-chip ${enabled ? 'enabled' : ''}">${provider}</span>`)
    .join('')

  return `
    <section class="bento-grid">
      <article class="bento-card span-5">
        <div class="section-heading">
          <p class="eyebrow">/ API ACCESS</p>
          <h2>Estado de fuentes</h2>
        </div>
        <div class="status-grid">${statusItems}</div>
      </article>
      <article class="bento-card span-7">
        <form id="settings-form" class="settings-form">
          ${inputField('finnhubApiKey', 'Finnhub API key', state.settings.finnhubApiKey)}
          ${inputField('marketauxApiKey', 'Marketaux API key', state.settings.marketauxApiKey)}
          ${inputField('eulerpoolApiKey', 'Eulerpool API key', state.settings.eulerpoolApiKey)}
          ${inputField('secUserAgent', 'SEC User-Agent', state.settings.secUserAgent, 'text')}
          <label>
            Perfil de riesgo
            <select name="riskProfile">
              ${riskOption('defensive', 'Defensivo')}
              ${riskOption('balanced', 'Balanceado')}
              ${riskOption('bold', 'Bold')}
            </select>
          </label>
          <details>
            <summary>Fuentes opcionales</summary>
            ${inputField('alphaVantageApiKey', 'Alpha Vantage API key', state.settings.alphaVantageApiKey)}
            ${inputField('fmpApiKey', 'FMP API key', state.settings.fmpApiKey)}
            ${inputField('eodhdApiKey', 'EODHD API key', state.settings.eodhdApiKey)}
          </details>
          <button class="primary-button" type="submit">Guardar claves locales</button>
        </form>
      </article>
    </section>
  `
}

function inputField(name: keyof AppSettings, label: string, value: string, type = 'password'): string {
  return `
    <label>
      ${label}
      <input name="${name}" type="${type}" value="${escapeHtml(value)}" autocomplete="off" />
    </label>
  `
}

function riskOption(value: AppSettings['riskProfile'], label: string): string {
  const selected = state.settings.riskProfile === value ? 'selected' : ''
  return `<option value="${value}" ${selected}>${label}</option>`
}

function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      state.view = button.dataset.view as ViewName
      render()
    })
  })

  document.querySelector<HTMLButtonElement>('#invest-button')?.addEventListener('click', () => {
    state.view = 'dashboard'
    render()
  })

  document.querySelector<HTMLButtonElement>('#refresh-btn')?.addEventListener('click', async () => {
    state.isRefreshing = true
    render()

    try {
      const all = await buildLiveRecommendations(state.settings)
      state.allRecommendations = all
      state.recommendations = all.slice(0, 3)
      state.lastUpdatedAt = Date.now()
    } catch {
      if (!state.recommendations.length) {
        state.recommendations = buildRecommendations(state.settings)
      }
    } finally {
      state.isRefreshing = false
      render()
    }
  })

  document.querySelector<HTMLButtonElement>('#sort-score-btn')?.addEventListener('click', () => {
    state.watchlistSortByScore = !state.watchlistSortByScore
    render()
  })

  document.querySelectorAll<HTMLButtonElement>('[data-register]').forEach((button) => {
    button.addEventListener('click', () => {
      const symbol = button.dataset.register
      const stock = WATCHLIST.find((item) => item.symbol === symbol)
      if (stock) registerHolding(stock)
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-delete-holding]').forEach((button) => {
    button.addEventListener('click', () => {
      state.holdings = state.holdings.filter((holding) => holding.id !== button.dataset.deleteHolding)
      saveHoldings(state.holdings)
      render()
    })
  })

  document.querySelector<HTMLFormElement>('#settings-form')?.addEventListener('submit', (event) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget as HTMLFormElement)
    state.settings = {
      finnhubApiKey: String(form.get('finnhubApiKey') ?? ''),
      marketauxApiKey: String(form.get('marketauxApiKey') ?? ''),
      eulerpoolApiKey: String(form.get('eulerpoolApiKey') ?? ''),
      alphaVantageApiKey: String(form.get('alphaVantageApiKey') ?? ''),
      fmpApiKey: String(form.get('fmpApiKey') ?? ''),
      eodhdApiKey: String(form.get('eodhdApiKey') ?? ''),
      secUserAgent: String(form.get('secUserAgent') ?? ''),
      riskProfile: String(form.get('riskProfile') ?? 'balanced') as AppSettings['riskProfile'],
    }
    saveSettings(state.settings)
    render()
  })

  // Stock row click → open price evolution modal
  document.querySelectorAll<HTMLElement>('[data-symbol]').forEach((row) => {
    row.addEventListener('click', () => openStockModal(row.dataset.symbol!))
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openStockModal(row.dataset.symbol!)
      }
    })
  })

  // Modal close button
  document.querySelector<HTMLButtonElement>('#modal-close')?.addEventListener('click', closeStockModal)

  // Click outside modal panel to close
  document.querySelector<HTMLElement>('#stock-modal')?.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).id === 'stock-modal') closeStockModal()
  })

  // Escape key to close modal
  document.addEventListener('keydown', handleModalEscape, { once: true })

  // Period toggle buttons
  document.querySelectorAll<HTMLButtonElement>('[data-days]').forEach((button) => {
    button.addEventListener('click', async () => {
      const days = parseInt(button.dataset.days ?? '30') as 30 | 60
      if (days === state.historyDays || !state.selectedStock || state.historyLoading) return
      state.historyDays = days
      await loadStockHistory(state.selectedStock)
    })
  })
}

function handleModalEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape' && state.selectedStock) closeStockModal()
}

function closeStockModal(): void {
  state.selectedStock = null
  state.stockHistory = null
  render()
}

async function openStockModal(symbol: string): Promise<void> {
  const stock = WATCHLIST.find((s) => s.symbol === symbol)
  if (!stock) return

  state.selectedStock = stock
  state.stockHistory = null
  await loadStockHistory(stock)
}

async function loadStockHistory(stock: WatchlistItem): Promise<void> {
  state.historyLoading = true
  render()

  try {
    const result = await fetchPriceHistory(stock, state.settings, state.historyDays)
    state.stockHistory = result.points
    state.historySource = result.source
  } catch {
    state.stockHistory = []
    state.historySource = ''
  } finally {
    state.historyLoading = false
    render()
  }
}

function registerHolding(stock: WatchlistItem): void {
  const recommendationPrice = state.recommendations.find((recommendation) => recommendation.stock.symbol === stock.symbol)?.price
  const price = recommendationPrice ?? mockCurrentPrice(stock)
  const units = 100 / toEur(price, stock.currency)
  const holding: Holding = {
    id: `${stock.symbol}-${Date.now()}`,
    symbol: stock.symbol,
    name: stock.name,
    investedEur: 100,
    buyPrice: price,
    currentPrice: price,
    currency: stock.currency,
    units: Number(units.toFixed(6)),
    boughtAt: new Date().toLocaleDateString('es-ES'),
  }

  state.holdings = [holding, ...state.holdings]
  saveHoldings(state.holdings)
  state.view = 'portfolio'
  render()
}

function marketPulse(recommendations: Recommendation[]): string {
  const average = recommendations.reduce((total, recommendation) => total + recommendation.score, 0) / recommendations.length
  if (average >= 72) return 'RISK ON'
  if (average >= 58) return 'SELECTIVE'
  return 'WAIT'
}

function formatEur(value: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value)
}

function formatSignedEur(value: number): string {
  const formatted = formatEur(Math.abs(value))
  return `${value >= 0 ? '+' : '-'}${formatted}`
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
