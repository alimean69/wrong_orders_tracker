# Order Monitoring API - Implementation Guide

This document provides a comprehensive guide on how to use, maintain, and extend the Order Monitoring and Daily Report API.

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: v18 or higher (v22 recommended)
- **MongoDB**: Access to the CRM and FLO databases
- **OpenAI API Key**: For AI-based verification of wrong orders

### 2. Environment Variables
Create a `.env` file in the root directory:

```env
PORT=3001
mongodb_uri=mongodb://...          # Primary CRM Database
flodb_uri=mongodb://...            # Secondary FLO Database
openai_api_key=sk-...              # OpenAI API Key for verification
API_AUTH_TOKEN=your_secure_token   # Token for Bearer authentication
ALLOWED_ORIGINS=*
```

---

## 🛡 Security & Authentication

The API is protected using **Bearer Token Authentication**. All endpoints under `/api` require a valid token.

### Header Format
```http
Authorization: Bearer <your_api_auth_token>
```

---

## 🗄 Database Selection

The API is designed to be multi-database aware. Every endpoint requires a `:db` parameter in the URL path to specify which database to target:
- `crmdb`: Targets the primary CRM database (`mongodb_uri`).
- `flodb`: Targets the secondary FLO database (`flodb_uri`).

---

## 🛠 API Reference

### 1. Run Daily Report
- **Endpoint**: `POST /api/reports/:db/run`
- **Example**: `POST /api/reports/crmdb/run`
- **Description**: This is the most important endpoint. It triggers the scanning process:
    1. Connects to the specified database.
    2. Scans for messages from the last 24 hours.
    3. Filters messages using suspicious keywords (e.g., "wrong", "missing", "instead of").
    4. Sends flagged messages to OpenAI for final verification.
    5. Saves results to `daily_report_<db>_output.json`.
- **Body**: `{"date": "YYYY-MM-DD"}` (Optional - defaults to last 24h).

### 2. Get Daily Metrics
- **Endpoint**: `GET /api/reports/:db/daily`
- **Example**: `GET /api/reports/flodb/daily`
- **Description**: Returns the latest summary report for the specified database.
- **Key Metrics**:
    - `totalDailyTickets`: Total tickets found in the date range.
    - `totalWrongOrdersDelivered`: Count of orders confirmed as "wrong" by AI.
- **Note on Zero Results**: If `totalWrongOrdersDelivered` is `0`, it means either no messages matched the keywords, or OpenAI determined that the complaints were not about receiving the wrong product (e.g., they were about late delivery or billing).

### 3. Get Confirmed Wrong Orders
- **Endpoint**: `GET /api/reports/:db/wrong-orders`
- **Example**: `GET /api/reports/crmdb/wrong-orders`
- **Description**: Returns a clean JSON array of all orders that have been AI-confirmed as "wrong item delivered" for that database.

### 4. Get Flagged Orders
- **Endpoint**: `GET /api/reports/:db/flagged-orders`
- **Example**: `GET /api/reports/flodb/flagged-orders`
- **Description**: Returns orders that hit the keyword filter but might not have been verified by AI yet (or were filtered in the current session).

---

## 📁 Project Structure

```text
Wrong_order_N/
├── src/
│   ├── middleware/     # Auth & Security middleware
│   ├── controllers/    # Request handlers
│   ├── routes/         # Route definitions
│   ├── services/       # Business logic (AI & DB)
│   └── utils/          # Logger
├── server.js           # Entry point
├── .env                # Secrets
└── daily_report_*.json # Persistence files per database
```

---

## 🔄 Customizing Logic

If you want to change which words trigger a "suspicious" flag, modify the `suspiciousKeywords` array in `src/services/reportService.js`:
```javascript
const suspiciousKeywords = ["wrong", "missing", "different item", ...];
```
