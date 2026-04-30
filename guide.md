# Order Monitoring API - Complete Documentation

This guide provides an A-to-Z overview of the Order Monitoring system, detailed API specifications, and step-by-step instructions for running reports.

---

## 🔐 1. Authentication & Security

The API uses **Bearer Token Authentication**. Every request to an `/api` endpoint must include a valid token in the headers.

- **Header**: `Authorization`
- **Value**: `Bearer <YOUR_API_AUTH_TOKEN>`

*Note: You can find or set this token in your `.env` file under `API_AUTH_TOKEN`.*

---

## 🗄 2. Supported Databases

The API supports multi-database routing. Replace `:db` in any path with one of the following:

| Database Identifier | Description |
| :--- | :--- |
| `crmdb` | Primary CRM database (as defined in `mongodb_uri`) |
| `flodb` | Secondary FLO database (as defined in `flodb_uri`) |
| `all` | Aggregates results from both databases simultaneously |

---

## 🛠 3. API Reference

### 3.1 Run Daily Report (Background Job)
Triggers the scanning process to identify wrong orders using Keyword filtering and AI verification.

- **Method**: `POST`
- **Path**: `/api/reports/:db/run`
- **Payload (JSON)**:
  ```json
  {
    "date": "2026-04-28" 
  }
  ```
  *(Optional: If `date` is omitted, it defaults to the last 24 hours.)*
- **Success Response (202 Accepted)**:
  ```json
  {
    "message": "Report generation started in the background.",
    "status": "processing",
    "jobId": "flowdb-2026-04-28",
    "checkStatusAt": "/api/reports/flowdb/daily?jobId=flowdb-2026-04-28"
  }
  ```

---

### 3.2 Check Report Status / Get Metrics
Check the progress of a running job or retrieve the latest generated metrics.

- **Method**: `GET`
- **Path**: `/api/reports/:db/daily`
- **Query Parameters**:
  - `jobId`: (Optional) The ID returned by the `run` endpoint to track a specific background job.
- **Success Response (While Processing)**:
  ```json
  {
    "jobId": "flowdb-2026-04-28",
    "status": "processing",
    "logs": [
      "[2026-05-01T00:40:00Z] Job started...",
      "[2026-05-01T00:40:05Z] Scanning messages..."
    ]
  }
  ```
- **Success Response (When Completed)**:
  ```json
  {
    "jobId": "flowdb-2026-04-28",
    "status": "completed",
    "data": {
      "totalDailyTickets": 150,
      "totalClosedTickets": 80,
      "totalWrongOrdersDelivered": 5,
      "wrongOrdersDetails": [...]
    }
  }
  ```

---

### 3.3 Get Confirmed Wrong Orders
Retrieves a list of all orders confirmed as "wrong" by AI for the specified database.

- **Method**: `GET`
- **Path**: `/api/reports/:db/wrong-orders`
- **Success Response**:
  ```json
  {
    "data": [
      {
        "customerEmail": "user@example.com",
        "conversationId": "662f...",
        "status": "closed",
        "wrongItem": true
      }
    ]
  }
  ```

---

### 3.4 Get Flagged Orders
Retrieves orders that matched the keywords but haven't necessarily been AI-verified as "wrong" yet.

- **Method**: `GET`
- **Path**: `/api/reports/:db/flagged-orders`
- **Success Response**:
  ```json
  {
    "data": [...]
  }
  ```

---

## 🚀 4. Step-by-Step Usage (A to Z)

### Step A: Initialize the Job
Send a POST request to start the background process.
```bash
curl -X POST http://localhost:3001/api/reports/crmdb/run \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"date": "2026-04-28"}'
```

### Step B: Monitor Progress
Use the `checkStatusAt` URL provided in the first response. Keep hitting this every 5-10 seconds to see the logs.
```bash
curl -X GET "http://localhost:3001/api/reports/crmdb/daily?jobId=crmdb-2026-04-28" \
     -H "Authorization: Bearer YOUR_TOKEN"
```

### Step C: Retrieve Final Results
Once the status in Step B says `"completed"`, you can either grab the `data` from that response OR hit the clean endpoint:
```bash
curl -X GET http://localhost:3001/api/reports/crmdb/daily \
     -H "Authorization: Bearer YOUR_TOKEN"
```

---

## ❌ 5. Error Handling

All error responses follow this schema:
```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "traceId": "unique-request-id"
  }
}
```

| Code | Meaning |
| :--- | :--- |
| `UNAUTHORIZED` | Missing or invalid Bearer token. |
| `INVALID_INPUT` | The provided date format is invalid. |
| `NOT_FOUND` | The requested database report file does not exist yet. |
| `INTERNAL` | A server-side crash or database connection failure. |

---

## 📂 6. File Persistence

The system saves results into JSON files in the root directory. These act as a simple cache so you don't have to re-run AI verification (which costs money) just to view the results again.

- `daily_report_<db>_output.json`: The full summary.
- `confirmed_wrong_orders_<db>.json`: List of confirmed orders.
- `flagged_wrong_orders_<db>.json`: List of keyword-matched orders.
