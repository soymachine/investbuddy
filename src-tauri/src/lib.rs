use std::collections::HashMap;
use std::sync::Mutex;
use rusqlite::Connection;
use tauri::Manager;

struct DbConn(Mutex<Connection>);

fn init_db(app: &tauri::App) -> Connection {
    let db_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    std::fs::create_dir_all(&db_dir).ok();
    let conn = Connection::open(db_dir.join("investbuddy.db"))
        .expect("Failed to open SQLite database");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS market_snapshots (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            data      TEXT    NOT NULL
        );",
    )
    .expect("Failed to create market_snapshots table");
    conn
}

#[tauri::command]
fn db_save_snapshot(
    state: tauri::State<DbConn>,
    data: String,
    timestamp: i64,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO market_snapshots (timestamp, data) VALUES (?1, ?2)",
        rusqlite::params![timestamp, data],
    )
    .map_err(|e| e.to_string())?;

    const SIXTY_DAYS_MS: i64 = 60 * 24 * 60 * 60 * 1000;
    conn.execute(
        "DELETE FROM market_snapshots WHERE timestamp < ?1",
        rusqlite::params![timestamp - SIXTY_DAYS_MS],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn db_load_latest_snapshot(
    state: tauri::State<DbConn>,
) -> Result<Option<(i64, String)>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT timestamp, data FROM market_snapshots ORDER BY timestamp DESC LIMIT 1",
        )
        .map_err(|e| e.to_string())?;
    match stmt.query_row([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))) {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn db_load_score_history(
    state: tauri::State<DbConn>,
    symbol: String,
) -> Result<Vec<(i64, f64, f64)>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT timestamp, data FROM market_snapshots ORDER BY timestamp ASC")
        .map_err(|e| e.to_string())?;

    let rows: Vec<(i64, String)> = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut result = Vec::new();
    for (timestamp, data) in rows {
        if let Ok(recs) = serde_json::from_str::<Vec<serde_json::Value>>(&data) {
            for rec in &recs {
                let sym = rec
                    .get("stock")
                    .and_then(|s| s.get("symbol"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                if sym.eq_ignore_ascii_case(&symbol) {
                    let score = rec.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let price = rec.get("price").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    result.push((timestamp, score, price));
                    break;
                }
            }
        }
    }

    Ok(result)
}

#[tauri::command]
fn healthcheck() -> &'static str {
    "investbuddy-ready"
}

#[tauri::command]
async fn http_get_json(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let allowed = [
        "https://finnhub.io/",
        "https://api.marketaux.com/",
        "https://api.eulerpool.com/",
        "https://query1.finance.yahoo.com/",
        "https://query2.finance.yahoo.com/",
        "https://data.sec.gov/",
        "https://www.sec.gov/",
        "https://api.frankfurter.app/",
        "https://www.alphavantage.co/",
        "https://eodhd.com/",
        "https://financialmodelingprep.com/",
    ];

    if !allowed.iter().any(|prefix| url.starts_with(prefix)) {
        return Err(format!("Provider URL not allowed: {url}"));
    }

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; InvestBuddy/0.5.0)")
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = client.get(&url).header("Accept", "application/json");

    if let Some(extra) = headers {
        for (key, value) in extra {
            request = request.header(key, value);
        }
    }

    let response = request.send().await.map_err(|e| e.to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status} from {url}"));
    }

    response.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let conn = init_db(app);
            app.manage(DbConn(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            healthcheck,
            http_get_json,
            db_save_snapshot,
            db_load_latest_snapshot,
            db_load_score_history
        ])
        .run(tauri::generate_context!())
        .expect("error while running InvestBuddy");
}
