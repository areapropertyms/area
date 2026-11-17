require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { runDailyReport } = require('./services/dailyReports');

const cors = require("cors");
app.use(cors());

const app = express();
const root = __dirname;
const port = process.env.PORT || 3000;
const data = path.join(root, 'data');
const pdf = path.join(root, 'private', 'sample-property-brochure.pdf');
const timezone = process.env.REPORT_TIMEZONE || 'Asia/Kolkata';
const schedule = process.env.REPORT_CRON || '0 18 * * *';

fs.mkdirSync(data, { recursive: true });
for (const file of ['leads.json', 'enquiries.json']) {
  const target = path.join(data, file);
  if (!fs.existsSync(target)) fs.writeFileSync(target, '[]\n');
}

app.use(express.json({ limit: '30kb' }));
app.use(express.static(path.join(root, 'public')));

function save(file, obj) {
  let records = [];
  try {
    records = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(records)) records = [];
  } catch (_) {}
  records.push({ ...obj, createdAt: new Date().toISOString() });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(records, null, 2));
  fs.renameSync(temp, file);
}

const clean = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const phoneOK = value => /^[6-9]\d{9}$/.test(value);

app.post('/api/brochure', (req, res) => {
  const name = clean(req.body.name, 100);
  const phone = clean(req.body.phone, 10);
  if (name.length < 2 || !phoneOK(phone)) {
    return res.status(400).json({ message: 'Enter a valid name and 10-digit Indian mobile number.' });
  }
  if (!fs.existsSync(pdf)) return res.status(404).json({ message: 'Brochure unavailable.' });
  save(path.join(data, 'leads.json'), { name, phone, source: 'brochure' });
  return res.download(pdf, 'Estate-Co-Sample-Brochure.pdf');
});

app.post('/api/enquiry', (req, res) => {
  const enquiry = {
    name: clean(req.body.name, 100),
    phone: clean(req.body.phone, 10),
    email: clean(req.body.email, 150),
    address: clean(req.body.address, 250),
    property: clean(req.body.property, 160),
    message: clean(req.body.message, 1000)
  };
  if (enquiry.name.length < 2 || !phoneOK(enquiry.phone) || !enquiry.property) {
    return res.status(400).json({ message: 'Enter a valid name, mobile number and property.' });
  }
  if (enquiry.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(enquiry.email)) {
    return res.status(400).json({ message: 'Enter a valid email.' });
  }
  save(path.join(data, 'enquiries.json'), { ...enquiry, source: 'website' });
  return res.json({
    message: 'Saved',
    whatsappText: `Hello, I am ${enquiry.name}. Interested in ${enquiry.property}. Mobile: ${enquiry.phone}. Email: ${enquiry.email || 'Not provided'}. Address: ${enquiry.address || 'Not provided'}. Message: ${enquiry.message || 'None'}`
  });
});

app.get('/api/health', (_, res) => res.json({ status: 'ok' }));

if (!cron.validate(schedule)) {
  throw new Error(`Invalid REPORT_CRON expression: ${schedule}`);
}
cron.schedule(schedule, () => {
  console.log(`[daily-report] Scheduled run started (${schedule}, ${timezone}).`);
  runDailyReport().catch(error => console.error('[daily-report] Scheduled run error:', error.message));
}, { timezone });

app.listen(port, () => {
  console.log(`Estate & Co. running at http://localhost:${port}`);
  console.log(`Daily report scheduled for ${schedule} (${timezone}).`);
});
