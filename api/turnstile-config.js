"use strict";

// GET /api/turnstile-config
//
// Hands the browser the Cloudflare Turnstile *site key*. The site key is
// public by design (it ships in the page anyway), but this is a plain static
// site with no build step, so there is nothing to inject an environment
// variable into the HTML at build time. Serving it from here lets the key live
// in a Vercel environment variable (TURNSTILE_SITE_KEY) instead of being
// hardcoded in the repo.
//
// The Turnstile SECRET key (TURNSTILE_SECRET_KEY) is never touched here and is
// only ever read inside api/send-email.js.

module.exports = function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.setHeader("Cache-Control", "no-store");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  var siteKey = (process.env.TURNSTILE_SITE_KEY || "").trim();

  // Turnstile site keys are short alphanumeric strings (e.g. 0x4AAAAAAA...,
  // or the 1x0000...AA test keys). Refuse anything else so a mis-pasted secret
  // can never be served to the browser.
  if (!/^[0-9A-Za-z_-]{10,100}$/.test(siteKey)) {
    console.error("TURNSTILE_SITE_KEY is missing or malformed.");
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ ok: false, error: "Security check is not configured." });
  }

  // Guard against the secret key being pasted into the site-key variable.
  var secret = (process.env.TURNSTILE_SECRET_KEY || "").trim();
  if (secret && siteKey === secret) {
    console.error("TURNSTILE_SITE_KEY equals TURNSTILE_SECRET_KEY; refusing to serve it.");
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ ok: false, error: "Security check is not configured." });
  }

  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  return res.status(200).json({ ok: true, siteKey: siteKey });
};
