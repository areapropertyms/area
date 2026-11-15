const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'report-state.json');
const LOCK_FILE = path.join(DATA_DIR, 'daily-report.lock');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const ENQUIRIES_FILE = path.join(DATA_DIR, 'enquiries.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function fingerprint(record) {
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function getState() {
  return readJson(STATE_FILE, {
    delivered: {
      email: { leads: [], enquiries: [] },
      whatsapp: { leads: [], enquiries: [] }
    },
    whatsappFileSentDates: { leads: [], enquiries: [] },
    lastRunAt: null
  });
}

function ensureChannelState(state, channel) {
  state.delivered ||= {};
  state.delivered[channel] ||= { leads: [], enquiries: [] };
  state.delivered[channel].leads ||= [];
  state.delivered[channel].enquiries ||= [];
}

function getPending(channel, state) {
  ensureChannelState(state, channel);
  const leads = readJson(LEADS_FILE, []);
  const enquiries = readJson(ENQUIRIES_FILE, []);
  if (!Array.isArray(leads) || !Array.isArray(enquiries)) {
    throw new Error('Lead data files must contain JSON arrays.');
  }
  const delivered = state.delivered[channel];
  return {
    leads: leads.filter(item => !delivered.leads.includes(fingerprint(item))),
    enquiries: enquiries.filter(item => !delivered.enquiries.includes(fingerprint(item)))
  };
}

function markDelivered(channel, kind, records, state) {
  ensureChannelState(state, channel);
  const current = new Set(state.delivered[channel][kind]);
  records.forEach(record => current.add(fingerprint(record)));
  state.delivered[channel][kind] = [...current];
  state.lastRunAt = new Date().toISOString();
  writeJsonAtomic(STATE_FILE, state);
}

function makeReportFiles(pending, dateLabel) {
  return [
    {
      kind: 'leads',
      filename: `leads-${dateLabel}.json`,
      content: JSON.stringify(pending.leads, null, 2),
      records: pending.leads
    },
    {
      kind: 'enquiries',
      filename: `enquiries-${dateLabel}.json`,
      content: JSON.stringify(pending.enquiries, null, 2),
      records: pending.enquiries
    }
  ];
}

function getDateLabel() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.REPORT_TIMEZONE || 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function configuredEmail() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.ADMIN_EMAIL);
}

async function sendEmailReport(pending, files, dateLabel, state) {
  if (!configuredEmail()) throw new Error('Email is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS and ADMIN_EMAIL in .env.');
  const count = pending.leads.length + pending.enquiries.length;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: process.env.ADMIN_EMAIL,
    subject: `Estate & Co. Daily Lead Report — ${dateLabel}`,
    text: `Daily website lead report for ${dateLabel}.\nNew brochure leads: ${pending.leads.length}\nNew property enquiries: ${pending.enquiries.length}\nTotal new contacts: ${count}\n\nThe two JSON files are attached. Contact visitors using the phone numbers in the records.`,
    attachments: files.map(file => ({ filename: file.filename, content: file.content, contentType: 'application/json' }))
  });
  markDelivered('email', 'leads', pending.leads, state);
  markDelivered('email', 'enquiries', pending.enquiries, state);
  console.log(`[daily-report] Email sent to ${process.env.ADMIN_EMAIL} (${count} records).`);
}

function configuredWhatsApp() {
  return Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ADMIN_NUMBER && process.env.WHATSAPP_TEMPLATE_NAME);
}

async function graphRequest(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || `WhatsApp Graph API request failed (${response.status}).`;
    throw new Error(message);
  }
  return body;
}

async function uploadWhatsAppDocument(filename, content) {
  const version = process.env.META_GRAPH_VERSION || 'v23.0';
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const url = `https://graph.facebook.com/${version}/${phoneId}/media`;
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'text/plain');
  form.append('file', new Blob([content], { type: 'text/plain' }), filename);
  const result = await graphRequest(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
    body: form
  });
  if (!result.id) throw new Error(`WhatsApp did not return a media ID for ${filename}.`);
  return result.id;
}

async function sendWhatsAppTemplateDocument(filename, content, dateLabel) {
  const version = process.env.META_GRAPH_VERSION || 'v23.0';
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const whatsappFilename = filename.replace(/\.json$/i, '.txt');
  const mediaId = await uploadWhatsAppDocument(whatsappFilename, content);
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: process.env.WHATSAPP_ADMIN_NUMBER.replace(/\D/g, ''),
    type: 'template',
    template: {
      name: process.env.WHATSAPP_TEMPLATE_NAME,
      language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US' },
      components: [
        { type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename: whatsappFilename } }] },
        { type: 'body', parameters: [
          { type: 'text', text: dateLabel },
          { type: 'text', text: whatsappFilename }
        ] }
      ]
    }
  };
  await graphRequest(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

async function sendWhatsAppReport(pending, files, dateLabel, state) {
  if (!configuredWhatsApp()) throw new Error('WhatsApp is not configured. Set the WhatsApp Cloud API credentials and approved template details in .env.');
  const hasAnyNewRecords = pending.leads.length + pending.enquiries.length > 0;
  state.whatsappFileSentDates ||= { leads: [], enquiries: [] };

  for (const file of files) {
    state.whatsappFileSentDates[file.kind] ||= [];
    // A successful file is not sent twice on the same date, including after a partial failure.
    if (state.whatsappFileSentDates[file.kind].includes(dateLabel)) continue;
    if (!hasAnyNewRecords) continue;

    const currentPending = getPending('whatsapp', state)[file.kind];
    const content = JSON.stringify(currentPending, null, 2);
    const filename = `${file.kind}-${dateLabel}.json`;
    // Send both files when a report is due. If one category has no new records, its file contains [].
    await sendWhatsAppTemplateDocument(filename, content, dateLabel);
    if (currentPending.length) markDelivered('whatsapp', file.kind, currentPending, state);
    state.whatsappFileSentDates[file.kind].push(dateLabel);
    writeJsonAtomic(STATE_FILE, state);
    console.log(`[daily-report] WhatsApp ${filename} sent to admin.`);
  }
}

async function runDailyReport() {
  let lockFd;
  try {
    lockFd = fs.openSync(LOCK_FILE, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (age < 2 * 60 * 60 * 1000) {
        console.log('[daily-report] Another report run is active; skipping this run.');
        return;
      }
      fs.unlinkSync(LOCK_FILE);
      lockFd = fs.openSync(LOCK_FILE, 'wx');
    } else throw error;
  }
  try {
  const state = getState();
  const dateLabel = getDateLabel();
  const errors = [];

  for (const channel of ['email', 'whatsapp']) {
    try {
      const pending = getPending(channel, state);
      const count = pending.leads.length + pending.enquiries.length;
      if (count === 0) {
        console.log(`[daily-report] No new records pending for ${channel}; nothing sent.`);
        continue;
      }
      const files = makeReportFiles(pending, dateLabel);
      if (channel === 'email') await sendEmailReport(pending, files, dateLabel, state);
      else await sendWhatsAppReport(pending, files, dateLabel, state);
    } catch (error) {
      errors.push(`${channel}: ${error.message}`);
      console.error(`[daily-report] ${channel} failed:`, error.message);
    }
  }

  state.lastRunAt = new Date().toISOString();
  writeJsonAtomic(STATE_FILE, state);
  if (errors.length) throw new Error(errors.join(' | '));
  } finally {
    if (lockFd !== undefined) fs.closeSync(lockFd);
    try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
  }
}

module.exports = { runDailyReport };
