/**
 * POST /api/send-email  --  Vercel Serverless Function
 *
 * Receives the "Free Estimate" form from the site and emails it to the
 * business (plus an acknowledgement to the customer) through Resend.
 *
 * SPAM PROTECTION, in the order it runs -- every check happens BEFORE
 * anything is sent through Resend:
 *   1. same-origin check on browser requests
 *   2. honeypot field ("website") -- bots that fill it are silently dropped
 *   3. per-IP rate limit on attempts
 *   4. strict server-side validation of every field
 *   5. per-IP and per-recipient limits on emails actually sent
 *   6. Cloudflare Turnstile token verified server-side (fails closed)
 *
 * SECURITY: RESEND_API_KEY and TURNSTILE_SECRET_KEY are read from Vercel
 * environment variables and are only ever used in this file, on the server.
 * They are never sent to, or readable by, the browser -- the frontend only
 * talks to this endpoint (and receives the public Turnstile *site* key from
 * /api/turnstile-config).
 */
const { Resend } = require("resend");

const FROM = "Jerry Cheshire Land Clearing <contact@jerrycheshirelandclearingga.com>"; // display name + verified Resend sender address
const TO = "jerrylcheshire@gmail.com";
const BCC = "hello@uxlabs.pro"; // silent copy of every request
const SITE_URL = "https://jerrycheshirelandclearingga.com";
const SITE_LABEL = "jerrycheshirelandclearingga.com";
const PHONE_DISPLAY = "(912) 778-4126";
const PHONE_TEL = "+19127784126";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TIMEOUT_MS = 8000;

// Rate limits. Kept in memory per serverless instance -- see the note above
// the limiter below for what that does and doesn't guarantee.
const RATE = {
  attemptsPerIp: { limit: 10, windowMs: 10 * 60 * 1000 },  // any request that gets past the honeypot
  sendsPerIp: { limit: 3, windowMs: 60 * 60 * 1000 },      // emails actually sent
  sendsPerEmail: { limit: 2, windowMs: 60 * 60 * 1000 },   // per customer address (stops mail-bombing someone)
};

// Must match the checkbox / radio values in the form in index.html.
const ALLOWED_SERVICES = [
  "Land Clearing",
  "Excavation Services",
  "Pond Digging",
  "Site Preparation",
  "Road Building",
  "Other",
];
const ALLOWED_BEST_TIMES = ["Morning", "Afternoon", "Evening"];

const MAX = { name: 100, email: 254, phone: 40, location: 150, other: 200, tokenLength: 2048, bodyKeys: 20 };

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Collapse whitespace/control characters (incl. CR/LF) so user text can never
// break out of an email header such as the subject line.
function oneLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

// "2026-09-21" -> "Monday, September 21, 2026" (parsed as UTC so the day
// never shifts with the server's timezone).
function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Spam bots love dropping links into free-text fields; a real name, town or
// "other service" description never needs one.
const LINK_LIKE = /(https?:\/\/|www\.)/i;

// 7-15 digits (with the usual punctuation) plus an optional extension.
function isValidPhone(phone) {
  if (phone.length > MAX.phone) return false;
  const m = phone.match(/^(\+?[\d\s().\-]{7,25}?)(?:\s*(?:x|ext\.?|#)\s*\d{1,6})?$/i);
  if (!m) return false;
  const digits = (m[1].match(/\d/g) || []).length;
  return digits >= 7 && digits <= 15;
}

// Today (allowing for timezone differences) up to two years out.
function dateInRange(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (t < today - DAY_MS) return "Please choose today's date or a later one.";
  if (t > today + 730 * DAY_MS) return "Please choose a date within the next two years.";
  return null;
}

// Returns { error } or { data } -- data is the cleaned, validated submission.
// Every field is type-checked, trimmed, length-limited and format-checked
// here on the server; nothing the browser enforces is trusted.
function validate(body) {
  const name = oneLine(asString(body.name));
  const email = asString(body.email);
  const phone = oneLine(asString(body.phone));
  const location = oneLine(asString(body.location));
  const otherDetail = oneLine(asString(body.otherDetail));
  const bestTime = asString(body.bestTime);
  const estimateDate = asString(body.estimateDate);

  const services = Array.isArray(body.services)
    ? body.services.filter((s) => typeof s === "string" && ALLOWED_SERVICES.includes(s))
    : [];
  const uniqueServices = Array.from(new Set(services));

  if (!uniqueServices.length) return { error: "Please select at least one service." };

  if (!location) return { error: "Please tell us where you're located." };
  if (location.length > MAX.location) return { error: "Location is too long." };
  if (LINK_LIKE.test(location)) return { error: "Please remove any links from your location." };

  if (!estimateDate) return { error: "Please choose a date to discuss your estimate." };
  const estimateDateLabel = /^\d{4}-\d{2}-\d{2}$/.test(estimateDate) ? formatDate(estimateDate) : null;
  if (!estimateDateLabel) return { error: "Please choose a valid date." };
  const dateProblem = dateInRange(estimateDate);
  if (dateProblem) return { error: dateProblem };

  if (!name) return { error: "Please enter your name." };
  if (name.length > MAX.name) return { error: "Name is too long." };
  if (LINK_LIKE.test(name)) return { error: "Please remove any links from your name." };

  // Deliberately simple: one address, no whitespace, commas, or angle brackets
  // (keeps it safe to use as the To / Reply-To header).
  if (!email || email.length > MAX.email || !/^[^\s@,<>;:"()[\]\\]+@[^\s@,<>;:"()[\]\\]+\.[^\s@,<>;:"()[\]\\]{2,}$/.test(email)) {
    return { error: "Please enter a valid email address." };
  }

  if (!phone || !isValidPhone(phone)) return { error: "Please enter a valid phone number." };

  if (!ALLOWED_BEST_TIMES.includes(bestTime)) return { error: "Please choose a good time to call you." };

  if (uniqueServices.includes("Other")) {
    if (otherDetail.length > MAX.other) return { error: "Please keep the description of the other service shorter." };
    if (LINK_LIKE.test(otherDetail)) return { error: "Please remove any links from your description." };
  }

  return {
    data: {
      services: uniqueServices,
      otherDetail: uniqueServices.includes("Other") ? otherDetail : "",
      location,
      estimateDate,
      estimateDateLabel,
      name,
      email,
      phone,
      bestTime,
    },
  };
}

// ---- Abuse protection helpers ----------------------------------------------

// Browsers always send an Origin header on cross-site POSTs. If it names a
// different host than the one serving this function, another website is
// trying to drive our form -- refuse. (Requests with no Origin header, i.e.
// non-browser clients, are still stopped by Turnstile + the rate limits.)
function isSameOrigin(req) {
  const headers = req.headers || {};
  const origin = headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === headers.host;
  } catch (e) {
    return false;
  }
}

// On Vercel, x-real-ip / x-forwarded-for carry the real client address.
function clientIp(req) {
  const headers = req.headers || {};
  const real = typeof headers["x-real-ip"] === "string" ? headers["x-real-ip"].trim() : "";
  const forwarded = typeof headers["x-forwarded-for"] === "string" ? headers["x-forwarded-for"].split(",")[0].trim() : "";
  return real || forwarded || (req.socket && req.socket.remoteAddress) || "";
}

/**
 * Basic sliding-window rate limiter.
 *
 * HONEST LIMITATION: the counters live in this serverless instance's memory.
 * That reliably slows down a script hammering the endpoint (Vercel reuses warm
 * instances for bursts of traffic), but it is not a shared, global limit --
 * separate instances each keep their own counts and a cold start resets them.
 * For a hard, global limit also add a Vercel Firewall rate-limiting rule for
 * /api/send-email in the Vercel dashboard (no code needed).
 */
const rateStore = new Map(); // key -> { times: number[], windowMs: number }
const RATE_STORE_MAX_KEYS = 5000;

function pruneRateStore(now) {
  for (const [key, entry] of rateStore) {
    entry.times = entry.times.filter((t) => now - t < entry.windowMs);
    if (!entry.times.length) rateStore.delete(key);
  }
}

// Is this key already at its limit? Returns seconds to wait, or 0 if allowed.
function rateRetryAfter(key, { limit, windowMs }) {
  const now = Date.now();
  const entry = rateStore.get(key);
  if (!entry) return 0;
  entry.times = entry.times.filter((t) => now - t < windowMs);
  if (entry.times.length < limit) return 0;
  return Math.max(1, Math.ceil((entry.times[0] + windowMs - now) / 1000));
}

function rateRecord(key, { windowMs }) {
  const now = Date.now();
  if (rateStore.size > RATE_STORE_MAX_KEYS) pruneRateStore(now);
  const entry = rateStore.get(key) || { times: [], windowMs };
  entry.windowMs = windowMs;
  entry.times.push(now);
  rateStore.set(key, entry);
}

// Verifies a Turnstile token with Cloudflare. Fails CLOSED: anything other
// than an explicit success from Cloudflare means "do not send".
async function verifyTurnstile(token, ip, secret) {
  const params = new URLSearchParams();
  params.set("secret", secret);
  params.set("response", token);
  if (ip) params.set("remoteip", ip);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURNSTILE_TIMEOUT_MS);
  try {
    const response = await globalThis.fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: params,
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, unavailable: true, codes: [`http-${response.status}`] };
    const result = await response.json();
    const codes = Array.isArray(result["error-codes"]) ? result["error-codes"] : [];
    return { ok: result.success === true, codes };
  } catch (err) {
    return { ok: false, unavailable: true, codes: [err && err.name === "AbortError" ? "timeout" : "network-error"] };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Shared pieces of both emails -----------------------------------------

function servicesList(d) {
  return d.services.map((s) => (s === "Other" && d.otherDetail ? `Other: ${d.otherDetail}` : s));
}

// Plain-text lines listing every submitted detail (used by both emails).
function detailLines(d) {
  return [
    `Name: ${d.name}`,
    `Email: ${d.email}`,
    `Phone: ${d.phone}`,
    `Services: ${servicesList(d).join(", ")}`,
    `Location: ${d.location}`,
    `Preferred date to discuss estimate: ${d.estimateDateLabel}`,
    `Best time to call: ${d.bestTime}`,
  ];
}

// The details table -- identical layout in the business email and the
// customer's acknowledgement.
function detailsTableHtml(d) {
  const row = (label, valueHtml) =>
    `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid #e0e3e8;font-weight:700;color:#034089;width:190px;vertical-align:top;">${label}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e0e3e8;color:#12213c;vertical-align:top;">${valueHtml}</td>
    </tr>`;

  const servicesHtml = servicesList(d)
    .map((s) => `<li style="margin:0 0 4px;">${escapeHtml(s)}</li>`)
    .join("");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;line-height:1.5;">
            ${row("Name", escapeHtml(d.name))}
            ${row("Email", `<a href="mailto:${escapeHtml(d.email)}" style="color:#034089;">${escapeHtml(d.email)}</a>`)}
            ${row("Phone", `<a href="tel:${escapeHtml(d.phone.replace(/[^\d+]/g, ""))}" style="color:#034089;">${escapeHtml(d.phone)}</a>`)}
            ${row("Services requested", `<ul style="margin:0;padding-left:18px;">${servicesHtml}</ul>`)}
            ${row("Location", escapeHtml(d.location))}
            ${row("Preferred date to discuss estimate", escapeHtml(d.estimateDateLabel))}
            ${row("Best time to call", escapeHtml(d.bestTime))}
          </table>`;
}

// Same branded shell for both emails; only the heading, intro and note differ.
function emailShellHtml({ title, subtitle, introHtml, d, noteHtml }) {
  return `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:24px;background:#f6f8fa;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e0e3e8;">
      <tr>
        <td style="background:#034089;padding:20px 24px;border-bottom:5px solid #fec619;">
          <div style="color:#ffffff;font-size:20px;font-weight:700;">${title}</div>
          <div style="color:#d6e0ee;font-size:13px;margin-top:4px;">${subtitle}</div>
        </td>
      </tr>${introHtml ? `
      <tr>
        <td style="padding:20px 24px 6px;font-size:15px;line-height:1.55;color:#12213c;">
          ${introHtml}
        </td>
      </tr>` : ""}
      <tr>
        <td style="padding:8px 10px 0;">
          ${detailsTableHtml(d)}
        </td>
      </tr>
      <tr>
        <td style="padding:18px 24px 22px;font-size:13px;color:#46515f;">
          ${noteHtml}
        </td>
      </tr>
      <tr>
        <td style="padding:14px 24px;background:#f6f8fa;border-top:1px solid #e0e3e8;font-size:12px;color:#46515f;text-align:center;">
          Jerry Cheshire Land Clearing Services &middot; <a href="${SITE_URL}" style="color:#034089;">${SITE_LABEL}</a>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// ---- Email 1: the lead, sent to the business ------------------------------

function buildBusinessEmail(d) {
  const text = [
    "New Free Estimate Request",
    "",
    ...detailLines(d),
    "",
    "Reply to this email to respond directly to the customer.",
    "",
    `Jerry Cheshire Land Clearing Services - ${SITE_URL}`,
  ].join("\n");

  const html = emailShellHtml({
    title: "New Free Estimate Request",
    subtitle: "Submitted from the Jerry Cheshire Land Clearing Services website",
    introHtml: "",
    d,
    noteHtml: `Hit <strong>Reply</strong> to respond directly to ${escapeHtml(d.name)} &mdash; their email address is set as the Reply-To.`,
  });

  return { subject: `New Free Estimate Request from ${d.name}`, text, html };
}

// ---- Email 2: acknowledgement sent to the customer ------------------------

function buildCustomerEmail(d) {
  const firstName = d.name.split(" ")[0];

  const text = [
    `Hi ${firstName},`,
    "",
    "Thank you for contacting Jerry Cheshire Land Clearing Services. We've received your free estimate request and will be in touch soon at the time you selected.",
    `Need us sooner? Call ${PHONE_DISPLAY}.`,
    "",
    "Here's a copy of what you sent us:",
    "",
    ...detailLines(d),
    "",
    "Reply to this email to reach us directly.",
    "",
    `Jerry Cheshire Land Clearing Services - ${SITE_URL}`,
  ].join("\n");

  const html = emailShellHtml({
    title: "We&rsquo;ve Received Your Request",
    subtitle: "Free Estimate Request &mdash; Jerry Cheshire Land Clearing Services",
    introHtml: `Hi ${escapeHtml(firstName)},<br><br>
          Thank you for contacting Jerry Cheshire Land Clearing Services. We&rsquo;ve received your free estimate request and will be in touch soon at the time you selected. Need us sooner? Call <a href="tel:${PHONE_TEL}" style="color:#034089;font-weight:700;">${PHONE_DISPLAY}</a>.<br><br>
          <strong>Here&rsquo;s a copy of what you sent us:</strong>`,
    d,
    noteHtml: `Just hit <strong>Reply</strong> to reach us directly &mdash; your message goes straight to Jerry.`,
  });

  return { subject: "We've received your estimate request - Jerry Cheshire Land Clearing", text, html };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  // 1. Same-origin: refuse browser requests coming from another website.
  if (!isSameOrigin(req)) {
    return res.status(403).json({ error: "Request not allowed." });
  }

  // Vercel parses JSON bodies automatically; tolerate a raw string just in case.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > MAX.bodyKeys) {
    return res.status(400).json({ error: "Invalid request." });
  }

  // 2. Honeypot: real visitors never see or fill the hidden "website" field;
  // bots often do. Pretend it worked so the bot learns nothing, but send
  // nothing (and spend no Cloudflare / Resend calls on it). "botField" is the
  // name an older version of the page's script used.
  if (asString(body.website) || asString(body.botField)) {
    return res.status(200).json({ ok: true });
  }

  // Fail closed if the server isn't fully configured: never send unprotected.
  const apiKey = process.env.RESEND_API_KEY;
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  if (!apiKey || !turnstileSecret) {
    console.error(
      "send-email: missing server configuration:",
      [!apiKey && "RESEND_API_KEY", !turnstileSecret && "TURNSTILE_SECRET_KEY"].filter(Boolean).join(", ")
    );
    return res.status(500).json({ error: "Email service is not configured." });
  }

  const ip = clientIp(req);
  const tooMany = (retryAfter) => {
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({
      error: `Too many requests. Please try again a little later, or call us at ${PHONE_DISPLAY}.`,
    });
  };

  // 3. Per-IP attempt limit (also protects the Cloudflare verification call).
  if (ip) {
    const wait = rateRetryAfter(`attempt:${ip}`, RATE.attemptsPerIp);
    if (wait) return tooMany(wait);
    rateRecord(`attempt:${ip}`, RATE.attemptsPerIp);
  }

  // 4. Validate every field.
  const result = validate(body);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  const d = result.data;

  // 5. Limits on emails actually sent: per IP, and per customer address
  // (the acknowledgement goes to whatever address the visitor typed).
  const emailKey = `email:${d.email.toLowerCase()}`;
  const sendIpKey = ip ? `send:${ip}` : "";
  const waitEmail = rateRetryAfter(emailKey, RATE.sendsPerEmail);
  if (waitEmail) return tooMany(waitEmail);
  if (sendIpKey) {
    const waitIp = rateRetryAfter(sendIpKey, RATE.sendsPerIp);
    if (waitIp) return tooMany(waitIp);
  }

  // 6. Cloudflare Turnstile -- verified server-side, before Resend is touched.
  const token = asString(body.turnstileToken);
  if (!token || token.length > MAX.tokenLength) {
    return res.status(403).json({ error: "Please complete the security check and try again." });
  }
  const verdict = await verifyTurnstile(token, ip, turnstileSecret);
  if (!verdict.ok) {
    if (verdict.codes.some((c) => c === "missing-input-secret" || c === "invalid-input-secret")) {
      console.error("send-email: Cloudflare rejected TURNSTILE_SECRET_KEY:", verdict.codes.join(", "));
      return res.status(500).json({ error: "Email service is not configured." });
    }
    if (verdict.unavailable || verdict.codes.includes("internal-error")) {
      console.error("send-email: Turnstile verification unavailable:", verdict.codes.join(", "));
      return res.status(503).json({
        error: `We couldn't verify your submission right now. Please try again in a moment, or call us at ${PHONE_DISPLAY}.`,
      });
    }
    console.warn("send-email: Turnstile verification failed:", verdict.codes.join(", "));
    return res.status(403).json({ error: "Security check failed. Please try again." });
  }

  // Passed every check: count it against the send limits, then send.
  rateRecord(emailKey, RATE.sendsPerEmail);
  if (sendIpKey) rateRecord(sendIpKey, RATE.sendsPerIp);

  const resend = new Resend(apiKey);

  // Email 1 -- the lead itself, to the business. This is the one that
  // matters: if it fails, tell the visitor so they can call instead.
  const business = buildBusinessEmail(d);
  try {
    const { error } = await resend.emails.send({
      from: FROM,
      to: TO,
      bcc: BCC,
      replyTo: d.email, // replying goes straight to the customer
      subject: business.subject,
      html: business.html,
      text: business.text,
    });

    if (error) {
      console.error("send-email: Resend rejected the business email:", error.name || "", error.message || "");
      return res.status(502).json({ error: "We couldn't send your message right now." });
    }
  } catch (err) {
    console.error("send-email: unexpected error sending the business email:", err && err.message ? err.message : err);
    return res.status(502).json({ error: "We couldn't send your message right now." });
  }

  // Email 2 -- acknowledgement to the customer (replies go to the business).
  // Sent only after the lead is safely delivered, and a failure here is
  // logged but never shown to the visitor: the business already has the
  // request, so from the visitor's side their message was sent.
  const customer = buildCustomerEmail(d);
  try {
    const { error } = await resend.emails.send({
      from: FROM,
      to: d.email,
      bcc: BCC,
      replyTo: TO,
      subject: customer.subject,
      html: customer.html,
      text: customer.text,
    });
    if (error) {
      console.error("send-email: Resend rejected the customer acknowledgement:", error.name || "", error.message || "");
    }
  } catch (err) {
    console.error("send-email: unexpected error sending the customer acknowledgement:", err && err.message ? err.message : err);
  }

  return res.status(200).json({ ok: true });
};
