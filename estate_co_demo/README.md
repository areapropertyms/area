# Estate & Co. — Real Estate Website + Automated Daily Lead Reports

## Included pages
- `public/index.html` — home page and featured properties
- `public/properties.html` — searchable, filterable and sortable property list
- `public/property.html?id=...` — individual property details and photo gallery
- `public/about.html` — company profile, brochure gate and enquiry form

## 1. Install and run locally

Install Node.js 18 or later (Node.js 20/22 LTS recommended). In VS Code, open this project folder and run:

```bash
npm install
```

Copy `.env.example` to a new file named `.env`, fill in the email and WhatsApp settings described below, then start:

```bash
npm start
```

Open `http://localhost:3000`. Do not open the HTML files directly; the forms and backend routes require the Express server.

## 2. Daily report behaviour

The scheduler runs every day at **18:00 India time** using `node-cron` and the `Asia/Kolkata` timezone. It sends two attachments/reports:
- `leads-YYYY-MM-DD.json` — visitors who submitted the brochure form
- `enquiries-YYYY-MM-DD.json` — visitors who submitted the property enquiry form

Email receives the exact `.json` files. WhatsApp receives the same JSON content as `.txt` documents because WhatsApp's document media support is more reliable with text files than a raw `.json` MIME type. The contents remain valid JSON and can be copied into a `.json` file if needed.

Only records not successfully reported to that delivery channel are included. Email and WhatsApp have separate delivery tracking, so a successful email is not resent just because WhatsApp failed (and vice versa). Each WhatsApp file is tracked separately; if the first document succeeds and the second fails, a retry sends only the remaining document. Delivery fingerprints are stored in `data/report-state.json`.

By default, no message is sent on a day when there are no new records. Existing lead/enquiry JSON files are not cleared or modified by report delivery. Do not delete `data/report-state.json`, or previously delivered records may be sent again.

### Test the report immediately

After completing the credentials, run:

```bash
npm run report:now
```

This uses the same deduplication state as the scheduled job. To test again, submit a fresh test brochure lead or enquiry first. The script logs which channel succeeded or failed.

## 3. Configure email delivery (Gmail example)

In `.env`, set:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-admin-sender@gmail.com
SMTP_PASS=your-google-app-password
MAIL_FROM="Estate & Co. Reports <your-admin-sender@gmail.com>"
ADMIN_EMAIL=admin@example.com
```

For Gmail, enable 2-Step Verification and create a Google App Password. Use that App Password as `SMTP_PASS`; do not use your normal Gmail password. `ADMIN_EMAIL` is where the daily report will be delivered.

## 4. Configure WhatsApp delivery (Meta WhatsApp Cloud API)

WhatsApp automated reports are sent through the official Meta WhatsApp Business Cloud API. A personal WhatsApp number alone is not sufficient. You need:
1. A Meta developer app with the WhatsApp product configured.
2. A WhatsApp Business phone number and its **Phone Number ID**.
3. An access token with the `whatsapp_business_messaging` permission. Use a production/system-user token for deployment, not a short-lived test token.
4. The admin recipient number in international format, digits only (India example: `919876543210`). The admin must have opted in to receive these WhatsApp notifications.
5. An approved WhatsApp message template configured with a **Document header** and two body variables.

Create and submit this template in WhatsApp Manager:
- Template name: `estate_daily_report` (or set your chosen name in `.env`)
- Category: Utility (Meta decides final categorisation/approval)
- Language: English (US) / `en_US` (or set the exact language code in `.env`)
- Header: Document
- Body text: `Your Estate & Co. daily lead report for {{1}} is attached. File: {{2}}.`

The template must have exactly the document header and the two body placeholders shown above. Wait until Meta approves it before testing.

Then configure `.env`:

```env
META_GRAPH_VERSION=v23.0
WHATSAPP_ACCESS_TOKEN=your_meta_access_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_ADMIN_NUMBER=919876543210
WHATSAPP_TEMPLATE_NAME=estate_daily_report
WHATSAPP_TEMPLATE_LANGUAGE=en_US
```

Use a Graph API version currently supported by Meta for your app. If you change the template name or language, update the matching `.env` values. The system uploads each JSON report as a `.txt` document and sends it using the approved document-header template. When at least one new record is pending, WhatsApp receives two separate documents: one for leads and one for enquiries. If one category has no new records, that file contains an empty JSON array (`[]`).

**WhatsApp restriction:** Outside the 24-hour customer-service window, Meta requires an approved template. A normal free-form message is not a reliable way to send a scheduled daily report. Meta may also reject messages if the recipient has not opted in, the template is not approved, the token lacks permissions, or the phone-number ID is wrong.

## 5. Change the schedule

Default values in `.env`:

```env
REPORT_CRON=0 18 * * *
REPORT_TIMEZONE=Asia/Kolkata
```

Examples:
- `0 18 * * *` — every day at 6:00 PM
- `0 9 * * *` — every day at 9:00 AM
- `30 18 * * *` — every day at 6:30 PM

Restart the Node server after changing `.env`.

## 6. Add new properties

Copy a property object in `public/js/properties.js`, give it a unique `id`, and update its name, location, price, measurements, description and image URLs. The home featured section and Properties listing use this array. Add the new property to the enquiry dropdown in `public/about.html` if visitors should be able to select it.

## 7. Important deployment requirements

- The Node process must remain running for the 6 PM cron job to execute. Sleeping/free-tier hosting may miss the schedule. Use an always-on Node host or an external scheduler.
- The `data/` directory must be on persistent storage. Ephemeral hosting can erase lead records and delivery state after a restart/deploy.
- Run only one application instance for this JSON-file version. The lock file prevents overlapping report runs in one shared data directory, but JSON storage is not a substitute for a database in a multi-instance production deployment.
- Protect `.env`, `data/`, and `private/`; do not place them under `public/` or expose them through static hosting.
- The current JSON-file storage is suitable for a demo/small pilot. For a live business, migrate leads and delivery state to a database, add authentication for admin access, HTTPS, rate limiting, backups, consent/privacy text and monitoring.
- Report state is stored in `data/report-state.json`. Back it up with the lead data. Do not reset it unless you intentionally want to re-send all stored records.

## Troubleshooting
- Email authentication fails: use a Gmail App Password and check SMTP host/port.
- WhatsApp returns an error: verify the permanent token, `whatsapp_business_messaging` permission, phone number ID, recipient opt-in and approved template name/language/header/body variables.
- No report arrives: check the Node terminal logs, ensure the server is running at 6 PM India time, and submit a fresh test lead. Successful records are intentionally not sent again.
