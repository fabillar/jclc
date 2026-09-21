/**
 * POST /api/send-email  --  Vercel Serverless Function
 *
 * Receives the "Free Estimate" form from the site and emails it to the
 * business through Resend.
 *
 * SECURITY: the Resend API key is read from the RESEND_API_KEY environment
 * variable (set in the Vercel project settings) and is only ever used in
 * this file, on the server. It is never sent to, or readable by, the
 * browser -- the frontend only talks to this endpoint.
 */
const { Resend } = require("resend");

const FROM = "Jerry Cheshire Land Clearing <contact@jerrycheshirelandclearingga.com>"; // display name + verified Resend sender address
const TO = "jerrylcheshire@gmail.com";
const BCC = "hello@uxlabs.pro"; // silent copy of every request
const SITE_URL = "https://jerrycheshirelandclearingga.com";
const SITE_LABEL = "jerrycheshirelandclearingga.com";
const PHONE_DISPLAY = "(912) 778-4126";
const PHONE_TEL = "+19127784126";

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

const MAX = { name: 100, email: 254, phone: 40, location: 150, other: 200 };

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

// Returns { error } or { data } -- data is the cleaned, validated submission.
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

  if (!estimateDate) return { error: "Please choose a date to discuss your estimate." };
  const estimateDateLabel = /^\d{4}-\d{2}-\d{2}$/.test(estimateDate) ? formatDate(estimateDate) : null;
  if (!estimateDateLabel) return { error: "Please choose a valid date." };

  if (!name) return { error: "Please enter your name." };
  if (name.length > MAX.name) return { error: "Name is too long." };

  // Deliberately simple: one address, no whitespace, commas, or angle brackets
  // (keeps it safe to use as the Reply-To header).
  if (!email || email.length > MAX.email || !/^[^\s@,<>;:"()[\]\\]+@[^\s@,<>;:"()[\]\\]+\.[^\s@,<>;:"()[\]\\]{2,}$/.test(email)) {
    return { error: "Please enter a valid email address." };
  }

  if (!phone || phone.length > MAX.phone || (phone.match(/\d/g) || []).length < 7) {
    return { error: "Please enter a valid phone number." };
  }

  if (!ALLOWED_BEST_TIMES.includes(bestTime)) return { error: "Please choose a good time to call you." };

  if (uniqueServices.includes("Other") && otherDetail.length > MAX.other) {
    return { error: "Please keep the description of the other service shorter." };
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

  // Vercel parses JSON bodies automatically; tolerate a raw string just in case.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Invalid request." });
  }

  // Honeypot: real visitors never see or fill this field; bots often do.
  // Pretend it worked so the bot doesn't learn anything, but send nothing.
  if (asString(body.botField)) {
    return res.status(200).json({ ok: true });
  }

  const result = validate(body);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  const d = result.data;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("send-email: RESEND_API_KEY is not set in this environment.");
    return res.status(500).json({ error: "Email service is not configured." });
  }

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
