import './style.css'
import { WATCHLIST } from './data/watchlist'
import { getProviderStatus, hasMinimumDataAccess, mockCurrentPrice, toEur } from './services/marketData'
import { buildLiveRecommendations, buildRecommendations, scoreStock } from './services/scoring'
import { loadHoldings, loadSettings, saveHoldings, saveSettings } from './services/storage'
import type { AppSettings, Holding, Recommendation, WatchlistItem } from './types'

const APP_VERSION = '0.1.0'

type ViewName = 'dashboard' | 'watchlist' | 'portfolio' | 'settings'

interface AppState {
  view: ViewName
  settings: AppSettings
  holdings: Holding[]
  recommendations: Recommendation[]
  lastSignalAt: string | null
  isInvesting: boolean
}

const state: AppState = {
  view: 'dashboard',
  settings: loadSettings(),
  holdings: loadHoldings(),
  recommendations: [],
  lastSignalAt: null,
  isInvesting: false,
}

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('Missing app root')
}

render()

function render(): void {
  app.innerHTML = `
    <div class="app-shell">
      ${renderHeader()}
      <main class="workspace">
        ${renderHero()}
        ${renderView()}
      </main>
    </div>
  `

  bindEvents()
}

function renderHeader(): string {
  const access = hasMinimumDataAccess(state.settings) ? 'DATA READY' : 'KEYS PENDING'

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
        <div class="system-pill">${access}</div>
        <div class="version-pill">v${APP_VERSION}</div>
      </div>
    </header>
  `
}

function navButton(view: ViewName, label: string): string {
  const active = state.view === view ? 'is-active' : ''
  return `<button class="nav-link ${active}" data-view="${view}" type="button">${label}</button>`
}

function renderHero(): string {
  const subtitle = state.isInvesting
    ? 'Conectando Finnhub, Marketaux y Eulerpool. Si una fuente falla, el motor conserva fallback local.'
    : state.lastSignalAt
      ? `Ultima senal generada ${state.lastSignalAt}`
      : 'Pulsa INVERTIR para puntuar la watchlist fija con el modelo MVP.'
  const buttonLabel = state.isInvesting ? 'ANALIZANDO' : 'INVERTIR'

  return `
    <section class="hero-panel">
      <div class="hero-copy">
        <p class="eyebrow">/ CAPITAL DECISION SYSTEM</p>
        <h1>NO RUIDO,<br>SOLO MOVIMIENTO.</h1>
        <p class="hero-subtitle">${subtitle}</p>
      </div>
      <button class="invest-button" id="invest-button" type="button" ${state.isInvesting ? 'disabled' : ''}>
        <span>${buttonLabel}</span>
        <small>100 EUR / TOP 3</small>
      </button>
      <div class="orb" aria-hidden="true"></div>
    </section>
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
  return `
    <section class="bento-grid">
      <article class="bento-card span-12">
        <div class="section-heading">
          <p class="eyebrow">/ FIXED UNIVERSE</p>
          <h2>Watchlist inicial EEUU + Europa</h2>
        </div>
        <div class="stock-table" role="table" aria-label="Watchlist de acciones">
          ${WATCHLIST.map(renderStockRow).join('')}
        </div>
      </article>
    </section>
  `
}

function renderStockRow(stock: WatchlistItem): string {
  const recommendation = scoreStock(stock, state.settings)
  const providers = stock.providers.map((provider) => `<span>${provider}</span>`).join('')

  return `
    <div class="stock-row" role="row">
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

  document.querySelector<HTMLButtonElement>('#invest-button')?.addEventListener('click', async () => {
    state.isInvesting = true
    state.view = 'dashboard'
    render()

    try {
      state.recommendations = await buildLiveRecommendations(state.settings)
    } catch {
      state.recommendations = buildRecommendations(state.settings)
    } finally {
      state.lastSignalAt = new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })
      state.isInvesting = false
      render()
    }
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
