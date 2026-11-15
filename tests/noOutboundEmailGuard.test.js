// backend/tests/noOutboundEmailGuard.test.js
//
// ORAC Lane 9 - guard for finding L9-F01: there is no outbound email transport.
//
// Programme rule: outbound email does not exist; communications work is preview and audit only
// until it is separately authorised. This test fails if a mail-sending package is declared as a
// dependency or imported from backend/src, or if SMTP transport code appears. It is a tripwire,
// not a policy: a separately authorised change that adds real sending must edit this guard on
// purpose, in the same reviewed change.
//
// It looks only at declared dependencies, import specifiers, a few transport-creation patterns
// and the PATH strings of registered routes. It does not search free text, so comments and
// documentation cannot trip it.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(here, "../src");
const PACKAGE_JSON = path.resolve(here, "../package.json");

// Package names (or scopes) whose purpose is to send email.
const MAIL_PACKAGE_PATTERN = new RegExp(
  "^(" + [
    "nodemailer(-.+)?",
    "@sendgrid(/.+)?",
    "mailgun(\\.js|-js|-js-.+)?",
    "postmark",
    "@postmark/.+",
    "@aws-sdk/client-ses(v2)?",
    "resend",
    "emailjs(-.+)?",
    "smtp-.+",
    "smtpjs",
    "@mailchimp/.+",
    "mandrill-.+",
    "sparkpost",
    "@getbrevo/.+",
    "sib-api-v3-sdk",
    "node-mailjet",
    "mailjet(-.+)?"
  ].join("|") + ")$",
  "i"
);

// Code patterns that create a transport, point at an SMTP endpoint, or name a well-known
// mail-sending service host (so a plain fetch() to a provider's HTTP API is also caught).
const TRANSPORT_CODE_PATTERNS = [
  /\bcreateTransport\s*\(/,
  /\bsmtps?:\/\//i,
  /\bsendMail\s*\(/,
  /\bsmtp\.[a-z0-9-]+\.[a-z]{2,}\b/i,
  /\b(?:sendgrid\.(?:com|net)|mailgun\.(?:net|org)|postmarkapp\.com|resend\.com|brevo\.com|sendinblue\.com|mailjet\.com|mandrillapp\.com|sparkpostmail\.com|email-smtp\.[a-z0-9-]+\.amazonaws\.com)\b/i
];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function findMailTransportReferences(source) {
  const code = stripComments(source);
  const found = [];
  const specifierPatterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s+["']([^"']+)["']/gm
  ];
  for (const pattern of specifierPatterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1].replace(/^node:/, "");
      if (MAIL_PACKAGE_PATTERN.test(specifier)) found.push(`import ${specifier}`);
    }
  }
  for (const pattern of TRANSPORT_CODE_PATTERNS) {
    if (pattern.test(code)) found.push(`code ${pattern.source}`);
  }
  return found;
}

// A route whose path names email or sending. Path strings only, taken from router/app/api
// registrations such as router.post("/x", ...).
const SENDING_ROUTE_PATH = /(e-?mail|smtp|mailer|sendmail|send[-_]?(mail|email|message))/i;
const ROUTE_REGISTRATION = /\b(?:router|app|api)\.(?:get|post|put|patch|delete|all|use)\s*\(\s*([`"'])([^`"']*)\1/g;

function findSendingRoutes(source) {
  const code = stripComments(source);
  const found = [];
  for (const match of code.matchAll(ROUTE_REGISTRATION)) {
    if (SENDING_ROUTE_PATH.test(match[2])) found.push(match[2]);
  }
  return found;
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...sourceFiles(full));
    } else if (/\.(c|m)?js$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// ---------- the guard ----------

test("no mail-sending package is declared in backend/package.json", { skip: !fs.existsSync(PACKAGE_JSON) && "backend/package.json not found at ../package.json" }, () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
  const declared = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
    .flatMap((field) => Object.keys(pkg[field] || {}));
  assert.deepEqual(declared.filter((name) => MAIL_PACKAGE_PATTERN.test(name)), []);
});

test("no file under backend/src imports a mail-sending package or creates an SMTP transport", () => {
  assert.equal(fs.existsSync(SRC_DIR), true, "backend/src was expected at ../src");
  const files = sourceFiles(SRC_DIR);
  assert.ok(files.length > 0, "found source files to scan");
  const offenders = [];
  for (const file of files) {
    const hits = findMailTransportReferences(fs.readFileSync(file, "utf8"));
    if (hits.length) offenders.push(`${path.relative(SRC_DIR, file)}: ${hits.join(", ")}`);
  }
  assert.deepEqual(offenders, []);
});

test("no route under backend/src has an email or sending path", () => {
  const offenders = [];
  let registrations = 0;
  for (const file of sourceFiles(SRC_DIR)) {
    const source = fs.readFileSync(file, "utf8");
    registrations += [...stripComments(source).matchAll(ROUTE_REGISTRATION)].length;
    const hits = findSendingRoutes(source);
    if (hits.length) offenders.push(`${path.relative(SRC_DIR, file)}: ${hits.join(", ")}`);
  }
  assert.ok(registrations > 0, "found route registrations to scan (is backend/src/router.js present?)");
  assert.deepEqual(offenders, []);
});

// ---------- the detector itself (so the guard cannot silently stop working) ----------

test("the detector flags import, dynamic import, require and transport creation", () => {
  assert.deepEqual(findMailTransportReferences('import nodemailer from "nodemailer";'), ["import nodemailer"]);
  assert.deepEqual(findMailTransportReferences('import sg from "@sendgrid/mail";'), ["import @sendgrid/mail"]);
  assert.deepEqual(findMailTransportReferences('const m = await import("postmark");'), ["import postmark"]);
  assert.deepEqual(findMailTransportReferences('const r = require("resend");'), ["import resend"]);
  assert.deepEqual(findMailTransportReferences('import "@aws-sdk/client-ses";'), ["import @aws-sdk/client-ses"]);
  assert.ok(findMailTransportReferences("const t = transporter.createTransport({ host });").length > 0);
  assert.ok(findMailTransportReferences('const url = "smtp://mail.example.test:25";').length > 0);
  assert.ok(findMailTransportReferences("await transport.sendMail(message);").length > 0);
});

test("the detector flags a mail-service host or SMTP hostname, so a plain fetch() to a provider API is caught", () => {
  assert.ok(findMailTransportReferences('await fetch("https://api.sendgrid.com/v3/mail/send", { method: "POST" });').length > 0);
  assert.ok(findMailTransportReferences('const host = "api.eu.mailgun.net";').length > 0);
  assert.ok(findMailTransportReferences('const host = "api.postmarkapp.com";').length > 0);
  assert.ok(findMailTransportReferences('const host = "email-smtp.us-east-1.amazonaws.com";').length > 0);
  assert.ok(findMailTransportReferences('const host = "smtp.example.test";').length > 0);
});

test("the detector ignores comments and unrelated imports", () => {
  assert.deepEqual(findMailTransportReferences('// import nodemailer from "nodemailer";'), []);
  assert.deepEqual(findMailTransportReferences("/* const t = createTransport({}); */ const x = 1;"), []);
  assert.deepEqual(findMailTransportReferences('import crypto from "node:crypto";\nimport express from "express";\nimport pg from "pg";'), []);
  assert.deepEqual(findMailTransportReferences('const note = "we do not send email yet";'), []);
  assert.deepEqual(findMailTransportReferences('// await fetch("https://api.sendgrid.com/v3/mail/send");'), []);
  assert.deepEqual(findMailTransportReferences('const cfg = { smtp: { host } }; const x = config.smtp.host;'), []);
});

test("the route detector flags email or sending paths and ignores ordinary ones", () => {
  assert.deepEqual(findSendingRoutes('router.post("/send-email", handler);'), ["/send-email"]);
  assert.deepEqual(findSendingRoutes("router.get(`/admin/mailer/:id`, handler);"), ["/admin/mailer/:id"]);
  assert.deepEqual(findSendingRoutes("app.use('/api/smtp', x);"), ["/api/smtp"]);
  assert.deepEqual(findSendingRoutes('router.post("/quotes/:id/send-message", h);'), ["/quotes/:id/send-message"]);
  assert.deepEqual(findSendingRoutes('router.get("/notifications", getNotifications);'), []);
  assert.deepEqual(findSendingRoutes('router.post("/timesheets/reminders/run", run);'), []);
  assert.deepEqual(findSendingRoutes('// router.post("/send-email", handler);'), []);
});
