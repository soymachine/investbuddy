#[tauri::command]
fn healthcheck() -> &'static str {
    "investbuddy-ready"
}

#[tauri::command]
async fn http_get_json(url: String) -> Result<serde_json::Value, String> {
    let allowed = [
        "https://finnhub.io/",
        "https://api.marketaux.com/",
        "https://api.eulerpool.com/",
    ];

    if !allowed.iter().any(|prefix| url.starts_with(prefix)) {
        return Err("Provider URL not allowed".to_string());
    }

    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| error.to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("Provider returned HTTP {status}"));
    }

    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![healthcheck, http_get_json])
        .run(tauri::generate_context!())
        .expect("error while running InvestBuddy");
}
