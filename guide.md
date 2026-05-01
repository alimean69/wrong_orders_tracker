# Order Monitoring API & Dashboard - Complete Documentation

This guide provides a comprehensive overview of the Order Monitoring system, including the visual dashboard, background job tracking, and system configuration.

---

## 🖥 1. Visual Dashboard (Frontend)

The system includes a premium web dashboard to manage and monitor your reports visually.

- **Access**: Open your browser to `http://localhost:3001/` (or your configured port).
- **Features**:
    - **Live Logs**: Watch processing in real-time with color-coded log entries.
    - **Job Control**: Select database and date, then trigger runs or forced regenerations.
    - **Metrics Visualization**: See summary cards for total, flagged, and confirmed tickets.
    - **Data View**: Browse a table of confirmed wrong orders.
    - **Live Config**: Update your MongoDB URIs instantly via the ⚙️ settings button.

---

## 🔐 2. Authentication & Security

The API uses **Bearer Token Authentication**. All requests (including from the dashboard) must include a valid token.

- **Header**: `Authorization`
- **Value**: `Bearer <YOUR_API_AUTH_TOKEN>`

*Note: Set your token in the `.env` file under `API_AUTH_TOKEN`.*

---

## 🗄 3. Database Support

Replace `:db` in any path with one of the following:

| Identifier | Description |
| :--- | :--- |
| `crmdb` | Primary CRM database (`mongodb_uri`) |
| `flodb` / `flowdb` | Secondary FLO database (`flodb_uri`) |
| `all` | Aggregates results from both databases simultaneously |

---

## 🛠 4. API Reference

### 4.1 Run Daily Report
Starts a background scanning job.

- **Method**: `POST`
- **Path**: `/api/reports/:db/run`
- **Query Parameters**:
    - `force`: Set to `true` to bypass cache and force a fresh AI scan.
- **Payload**: `{"date": "YYYY-MM-DD"}` (Optional)
- **Response**: Returns a `jobId` and a `checkStatusAt` URL.

### 4.2 Check Status & Metrics
Retrieve progress logs or final metrics.

- **Method**: `GET`
- **Path**: `/api/reports/:db/daily`
- **Query Parameters**:
    - `jobId`: Use the ID from the `run` response to track a specific job.
- **Success Metrics**:
    - `totalDailyTickets`: All tickets in the date range.
    - `totalFlaggedTickets`: Tickets matching suspicious keywords.
    - `totalWrongOrdersDelivered`: Tickets confirmed as "wrong" by AI.

### 4.3 System Configuration
Manage database connections without restarting the server.

- **Get Config**: `GET /api/reports/system/config`
- **Update Config**: `POST /api/reports/system/config`
- **Payload**: `{"mongodb_uri": "...", "flodb_uri": "..."}`

---

## 🤖 5. AI Verification & Rate Limits

The system uses OpenAI (`gpt-4o-mini`) for verification. To handle strict rate limits:
- **Sequential Processing**: Messages are checked one by one.
- **Exponential Backoff**: If a `429 (Rate Limit)` error occurs, the system automatically pauses and retries (2s, 4s, 8s) before moving on.
- **Reporting**: Rate limit warnings are visible in the Live Logs on the dashboard.

---

## 🚀 6. Step-by-Step Usage

1.  **Open Dashboard**: Visit `http://localhost:3001/`.
2.  **Authorize**: Enter your `API_AUTH_TOKEN` in the control panel.
3.  **Run**: Select your database and date, then click **Run Job**.
4.  **Monitor**: Watch the logs for "Verifying conversation X/Y".
5.  **Review**: Once "Completed", check the **Wrong Orders Data** tab for the results.

---

## 📂 7. Project Structure

- `/public`: Dashboard frontend (`index.html`).
- `/src/services`: Business logic, AI verification, and DB handling.
- `/src/controllers`: API request handling and job state management.
- `/src/routes`: API route definitions.
- `server.js`: Express server entry point.
- `.env`: Secrets and configuration (dynamically updated).
