# Order Monitoring API & Dashboard - Complete Documentation

This guide provides a comprehensive overview of the Order Monitoring system, including the visual dashboard, background job tracking, system configuration, and operations metrics reporting.

---

## 🖥 1. Visual Dashboard (Frontend)

The system includes a premium web dashboard to manage and monitor your reports visually.

- **Access**: Open your browser to `http://localhost:3001/` (or your configured port).
- **Features**:
    - **Live Logs**: Watch processing in real-time with color-coded log entries (now supports both Wrong Orders and Operations Metrics).
    - **Wrong Order Scanning**: Monitor `crmdb` & `flowdb` for AI-verified errors.
    - **Operations Metrics**: Trailing 7-day report on fulfillment, shipping costs, and UPS transit times.
    - **Tabbed Interface**: Switch between Live Logs, Wrong Order Data, and Operations Metrics tables.
    - **Live Config**: Update your MongoDB URIs instantly via the ⚙️ settings button.

---

## 🔐 2. Authentication & Security

The API uses **Bearer Token Authentication**. 

- **Header (Standard)**: `Authorization: Bearer <YOUR_API_AUTH_TOKEN>`

*Note: Set your token in the `.env` file under `API_AUTH_TOKEN`.*

---

## 📊 3. Operations Metrics Reporting

This module provides high-level business intelligence by integrating ERP shipment data with real-time UPS tracking.

### 3.1 Time Window Logic
The report calculates metrics for a **7-day window** ending on the selected date.
*   **Example**: Selecting `2026-05-01` scans data from `2026-04-25` through `2026-05-01`.

### 3.2 Metrics Tracked
- **Total Shipments**: Count of unique orders shipped via UPS.
- **Avg Fulfillment Time**: Hours from Order Creation to Shipping Label creation.
- **Avg Shipping Cost**: The total shipping cost per order across all labels.
- **Avg Ship-to-Door Time**: Hours from Shipping Label creation to UPS "Delivered" status.

---

## 🛠 4. API Reference

### 4.1 Wrong Orders API
- **Run Job**: `POST /api/reports/:db/run`
- **Check Status**: `GET /api/reports/:db/daily`

### 4.2 Operations API
- **Check Status/Result**: `GET /api/ops?date=YYYY-MM-DD`
    - Returns a `202 Processing` status with logs and progress while running.
    - Returns a `200 OK` with full data and logs once complete.
- **Run Job**: `POST /api/ops/run`
    - Explicitly triggers a background generation for the specified date.

### 4.3 System Configuration
- **Get Config**: `GET /api/reports/system/config`
- **Update Config**: `POST /api/reports/system/config`

---

## 🤖 5. AI Verification & Parallel Processing

- **Wrong Orders**: Uses OpenAI (`gpt-4o-mini`) with exponential backoff for rate limit handling.
- **Operations Metrics**: Uses `p-limit` for highly concurrent UPS tracking requests (50 parallel requests) to maximize throughput without hitting UPS rate limits.

---

## 🚀 6. Step-by-Step Usage

1.  **Open Dashboard**: Visit `http://localhost:3001/`.
2.  **Authorize**: Enter your `API_AUTH_TOKEN` in the control panel.
3.  **Run Reports**:
    - **Wrong Orders**: Click "Run Wrong Orders" to start the AI verification scan.
    - **Operations**: Select a date and click "Run Operations Metrics".
4.  **Monitor Status**: The dashboard uses background polling to track progress. You can see real-time updates in the **Live Logs** tab, including fetch counts like `Progress: 45% (450/1000 tracking numbers fetched)`.
5.  **Review Results**: Once finished, results are displayed in the respective data tables and cached in the `reports/` folder.

---

## 📂 7. Project Structure

- `/public`: Dashboard frontend (`index.html`).
- `/reports`: Cached Operations Metrics JSON files.
- `/src/services`: Business logic (Wrong Orders, UPS Integration, ERP Database).
- `/src/controllers`: API request handling and background job coordination.
- `/src/routes`: API route definitions.
- `server.js`: Express server entry point.
- `.env`: Secrets and ERP Database credentials.
