# InvestBuddy

Aplicacion de escritorio para macOS creada con Tauri, Vite y TypeScript. El MVP analiza una watchlist fija de acciones EEUU/Europa, genera un ranking de 1 a 3 alternativas para invertir 100 EUR y permite registrar compras manuales realizadas fuera de la app.

## Estado actual

- UI inicial Bold & Experimental con grid bento, negro OLED y amarillo electrico.
- Watchlist fija EEUU + Europa.
- Boton `INVERTIR` con motor de scoring local mock-ready.
- Settings locales para API keys.
- Portfolio manual guardado en `localStorage`.
- Wrapper Tauri 2 configurado.

## Requisitos

- Node 20.
- Rust/Cargo.
- macOS para empaquetado `.app`/`.dmg`.

## Configuracion

1. Duplica `.env.example` como `.env`.
2. Rellena las claves disponibles.
3. No subas `.env` a Git.

```txt
VITE_FINNHUB_API_KEY=
VITE_MARKETAUX_API_KEY=
VITE_EULERPOOL_API_KEY=
VITE_ALPHA_VANTAGE_API_KEY=
VITE_FMP_API_KEY=
VITE_EODHD_API_KEY=
VITE_SEC_USER_AGENT=InvestBuddy/0.1 your-email@example.com
```

Tambien puedes introducir las claves desde `Settings` dentro de la app; se guardan localmente en el navegador/webview.

## Comandos

```bash
npm install
npm run dev
npm run build
npm run tauri:dev
npm run tauri:build
```

## Siguientes pasos tecnicos

- Sustituir datos mock por adaptadores reales: Finnhub, Marketaux, Eulerpool, SEC EDGAR, ECB y Stooq.
- Mover secretos a almacenamiento seguro de Tauri antes de usarlo como app real.
- Persistir portfolio en SQLite mediante comandos Rust.
- Anadir cache, rate limiting y control de errores por proveedor.
- Anadir graficos historicos por accion.

## Aviso

InvestBuddy no ejecuta inversiones ni garantiza beneficios. El ranking es una herramienta de analisis basada en senales y datos publicos; la compra real se hace externamente.
