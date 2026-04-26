use std::collections::HashMap;

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
        .user_agent("Mozilla/5.0 (compatible; InvestBuddy/0.3.0)")
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
        .invoke_handler(tauri::generate_handler![healthcheck, http_get_json])
        .run(tauri::generate_context!())
        .expect("error while running InvestBuddy");
}
