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

const FROM = "contact@jerrycheshirelandclearingga.com"; // verified Resend sender
const TO = "jerrylcheshire@gmail.com";
const BCC = "hello@uxlabs.pro"; // silent copy of every request

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

function buildEmail(d) {
  const servicesText = d.services
    .map((s) => (s === "Other" && d.otherDetail ? `Other: ${d.otherDetail}` : s))
    .join(", ");

  const text = [
    "New Free Estimate Request",
    "",
    `Name: ${d.name}`,
    `Email: ${d.email}`,
    `Phone: ${d.phone}`,
    `Services: ${servicesText}`,
    `Location: ${d.location}`,
    `Preferred date to discuss estimate: ${d.estimateDateLabel}`,
    `Best time to call: ${d.bestTime}`,
    "",
    "Reply to this email to respond directly to the customer.",
  ].join("\n");

  const row = (label, valueHtml) =>
    `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid #e0e3e8;font-weight:700;color:#034089;width:190px;vertical-align:top;">${label}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e0e3e8;color:#12213c;vertical-align:top;">${valueHtml}</td>
    </tr>`;

  const servicesHtml = d.services
    .map((s) => `<li style="margin:0 0 4px;">${escapeHtml(s === "Other" && d.otherDetail ? `Other: ${d.otherDetail}` : s)}</li>`)
    .join("");

  const html = `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:24px;background:#f6f8fa;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e0e3e8;">
      <tr>
        <td style="background:#034089;padding:20px 24px;border-bottom:5px solid #fec619;">
          <div style="color:#ffffff;font-size:20px;font-weight:700;">New Free Estimate Request</div>
          <div style="color:#d6e0ee;font-size:13px;margin-top:4px;">Submitted from the Jerry Cheshire Land Clearing Services website</div>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 10px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;line-height:1.5;">
            ${row("Name", escapeHtml(d.name))}
            ${row("Email", `<a href="mailto:${escapeHtml(d.email)}" style="color:#034089;">${escapeHtml(d.email)}</a>`)}
            ${row("Phone", `<a href="tel:${escapeHtml(d.phone.replace(/[^\d+]/g, ""))}" style="color:#034089;">${escapeHtml(d.phone)}</a>`)}
            ${row("Services requested", `<ul style="margin:0;padding-left:18px;">${servicesHtml}</ul>`)}
            ${row("Location", escapeHtml(d.location))}
            ${row("Preferred date to discuss estimate", escapeHtml(d.estimateDateLabel))}
            ${row("Best time to call", escapeHtml(d.bestTime))}
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:18px 24px 22px;font-size:13px;color:#46515f;">
          Hit <strong>Reply</strong> to respond directly to ${escapeHtml(d.name)} &mdash; their email address is set as the Reply-To.
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { text, html };
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

  const { text, html } = buildEmail(d);

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: FROM,
      to: TO,
      bcc: BCC,
      replyTo: d.email, // replying goes straight to the customer
      subject: `New Free Estimate Request from ${d.name}`,
      html,
      text,
    });

    if (error) {
      console.error("send-email: Resend rejected the message:", error.name || "", error.message || "");
      return res.status(502).json({ error: "We couldn't send your message right now." });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("send-email: unexpected error:", err && err.message ? err.message : err);
    return res.status(502).json({ error: "We couldn't send your message right now." });
  }
};
