(function () {
  "use strict";

  // Preloader: keep the page covered until the hero's background photo
  // (and, when motion is allowed, its background video) have actually
  // loaded -- so visitors never see the hero half-loaded. No-JS visitors
  // never see this at all: a <noscript> rule in the HTML hides #preloader
  // immediately, the same "never permanently hide content" principle used
  // by the scroll-reveal code below.
  // Loads the Vimeo Player SDK on demand (only needed while the preloader
  // is waiting on the hero background video) and reports back whether it's
  // actually usable, instead of leaving the caller to guess.
  var loadVimeoPlayerSDK = function (callback) {
    if (window.Vimeo && window.Vimeo.Player) {
      callback(true);
      return;
    }
    var script = document.createElement("script");
    script.src = "https://player.vimeo.com/api/player.js";
    script.onload = function () {
      callback(!!(window.Vimeo && window.Vimeo.Player));
    };
    script.onerror = function () {
      callback(false);
    };
    document.head.appendChild(script);
  };

  var preloader = document.getElementById("preloader");
  if (preloader) {
    var prefersReducedMotionForPreloader =
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var heroVideoFrameForPreloader = document.querySelector(".hero-video iframe");

    var preloaderPending = 1; // hero background photo, always waited on
    if (heroVideoFrameForPreloader && !prefersReducedMotionForPreloader) preloaderPending++;

    // Keep the loading screen up for at least this long, even if the hero
    // assets resolve almost instantly (e.g. warm cache) -- avoids an
    // unprofessional instant flash of the loading screen.
    var PRELOADER_MIN_MS = 1500;
    var preloaderShownAt = Date.now();
    var preloaderSafetyTimer;
    var preloaderMinDelayTimer;

    var hidePreloader = function () {
      if (!preloader || preloader.classList.contains("is-hidden")) return;
      preloader.classList.add("is-hidden");
      document.body.classList.remove("is-loading");
      // Lets the hero's own content (eyebrow, heading, badges, buttons)
      // drop into place right as the loading screen clears, instead of
      // just sitting there visible underneath it the whole time -- see
      // .hero-eyebrow / .hero h1 / .hero-badges / .hero-actions and
      // body.preloader-done in css/style.css.
      document.body.classList.add("preloader-done");
      window.clearTimeout(preloaderSafetyTimer);
      window.clearTimeout(preloaderMinDelayTimer);
      preloader.addEventListener(
        "transitionend",
        function () {
          if (preloader.parentNode) preloader.parentNode.removeChild(preloader);
        },
        { once: true }
      );
    };

    // Assets being ready doesn't hide the preloader immediately -- it only
    // does so once the minimum display time has also elapsed.
    var hidePreloaderWhenAssetsReady = function () {
      var elapsed = Date.now() - preloaderShownAt;
      if (elapsed >= PRELOADER_MIN_MS) {
        hidePreloader();
      } else {
        preloaderMinDelayTimer = window.setTimeout(hidePreloader, PRELOADER_MIN_MS - elapsed);
      }
    };

    var markPreloaderAssetLoaded = function () {
      preloaderPending -= 1;
      if (preloaderPending <= 0) hidePreloaderWhenAssetsReady();
    };

    document.body.classList.add("is-loading");

    // Re-request the same URL the CSS background-image already uses -- if
    // it's already cached (the stylesheet triggered the real fetch well
    // before this script ran), onload fires right away.
    var heroBgImage = new Image();
    heroBgImage.onload = markPreloaderAssetLoaded;
    heroBgImage.onerror = markPreloaderAssetLoaded; // never hang the page over a failed asset
    heroBgImage.src = "assets/hero-bg.jpg";

    if (heroVideoFrameForPreloader && !prefersReducedMotionForPreloader) {
      // The iframe's own "load" event fires as soon as Vimeo's player page
      // itself has loaded -- well before the video has actually buffered
      // and started rendering frames, so it was letting the preloader
      // clear while the video was still visibly not there yet. The Vimeo
      // Player SDK's "play" event is the real signal that the video is
      // up and rendering (this embed autoplays, so "play" fires on its
      // own -- no user interaction needed).
      loadVimeoPlayerSDK(function (sdkReady) {
        if (!sdkReady || !window.Vimeo || !window.Vimeo.Player) {
          // SDK failed to load (offline, blocked, etc.) -- fall back to the
          // iframe's load event rather than waiting forever on an API that
          // will never show up.
          heroVideoFrameForPreloader.addEventListener("load", markPreloaderAssetLoaded, { once: true });
          return;
        }
        try {
          var vimeoPlayer = new window.Vimeo.Player(heroVideoFrameForPreloader);
          var onFirstPlay = function () {
            vimeoPlayer.off("play", onFirstPlay);
            markPreloaderAssetLoaded();
          };
          vimeoPlayer.on("play", onFirstPlay);
          // Don't hang forever if the embed itself reports an error.
          vimeoPlayer.on("error", markPreloaderAssetLoaded);
        } catch (e) {
          markPreloaderAssetLoaded();
        }
      });
    }

    // Safety net: never leave a visitor staring at the loading screen if an
    // asset stalls (slow connection, blocked embed, autoplay refused,
    // etc.). Generous on purpose -- real video buffering over the network
    // legitimately takes longer than a still image, and the whole point of
    // this preloader is to actually wait for it rather than cut it short.
    preloaderSafetyTimer = window.setTimeout(hidePreloader, 15000);
  }

  // Footer year
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Mobile nav toggle
  var navToggle = document.getElementById("nav-toggle");
  var mainNav = document.getElementById("main-nav");
  if (navToggle && mainNav) {
    navToggle.addEventListener("click", function () {
      var isOpen = mainNav.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", String(isOpen));
    });
    mainNav.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        mainNav.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  // Header nav: "Services" submenu. Desktop shows it as a hover/focus
  // dropdown (pure CSS, no JS needed there); this handles the mobile
  // accordion toggle inside the off-canvas drawer, same expand/collapse
  // technique as the FAQ accordion below (max-height driven by scrollHeight).
  document.querySelectorAll(".submenu-toggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var item = btn.closest(".nav-item.has-submenu");
      var submenu = item && item.querySelector(".submenu");
      if (!item || !submenu) return;
      var isOpen = item.classList.toggle("is-open");
      btn.setAttribute("aria-expanded", String(isOpen));
      submenu.style.maxHeight = isOpen ? submenu.scrollHeight + "px" : null;
    });
  });

  // FAQ accordion
  document.querySelectorAll(".accordion-trigger").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var expanded = btn.getAttribute("aria-expanded") === "true";
      var panel = btn.nextElementSibling;

      // close others
      document.querySelectorAll(".accordion-trigger").forEach(function (other) {
        if (other !== btn) {
          other.setAttribute("aria-expanded", "false");
          other.nextElementSibling.style.maxHeight = null;
        }
      });

      btn.setAttribute("aria-expanded", String(!expanded));
      panel.style.maxHeight = expanded ? null : panel.scrollHeight + "px";
    });
  });

  // Scroll reveal — progressive enhancement only.
  // Elements are visible by default; we ONLY hide them here, right before
  // observing, so a JS error or an observer that never fires can never
  // leave content permanently invisible. A hard fallback timer also
  // guarantees everything is shown even if IntersectionObserver misbehaves.
  var prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var revealEls = document.querySelectorAll(
    ".service-card, .testimonial-card, .why-item, .about-copy, .about-art, .why-copy, .why-art, .about-character, .faq-character"
  );

  if ("IntersectionObserver" in window && !prefersReducedMotion) {
    revealEls.forEach(function (el) { el.classList.add("reveal-pending"); });

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -40px 0px" }
    );
    revealEls.forEach(function (el) { observer.observe(el); });

    // Safety net: force everything visible after a delay no matter what, in
    // case IntersectionObserver misbehaves. This used to fire after just
    // 1800ms, which is shorter than it typically takes a visitor to scroll
    // down to below-the-fold content (like the About/FAQ section) in the
    // first place -- so elements were being silently marked "is-visible"
    // (and their reveal transition run) off-screen, before anyone ever saw
    // it, making the reveal effect invisible in normal use. IntersectionObserver
    // doesn't need a tight timer to work correctly -- it fires whenever an
    // element actually enters the viewport, no matter how long that takes --
    // so this is purely a last-resort fallback and can afford to be generous.
    setTimeout(function () {
      revealEls.forEach(function (el) { el.classList.add("is-visible"); });
    }, 10000);
  }

  // Shrink the header's floating corner-style logo back down to a
  // normal, inline size once the page has scrolled -- so it only reads
  // as a big tilted "ribbon badge" over the hero at the very top, and
  // rests like a normal header logo elsewhere. The same "is-scrolled"
  // state is also mirrored onto <body> so the hero's own corner-ribbon
  // pseudo-element (.hero::before, which isn't a descendant of
  // .site-header) can react to it too -- see the "Hero corner ribbon"
  // rule in css/style.css, which slides it up and fades it out once
  // body.is-scrolled is present.
  var siteHeader = document.querySelector(".site-header");
  if (siteHeader) {
    var toggleHeaderScrolled = function () {
      if (window.scrollY > 10) {
        siteHeader.classList.add("is-scrolled");
        document.body.classList.add("is-scrolled");
      } else {
        siteHeader.classList.remove("is-scrolled");
        document.body.classList.remove("is-scrolled");
      }
    };
    toggleHeaderScrolled();

    var headerTicking = false;
    window.addEventListener(
      "scroll",
      function () {
        if (!headerTicking) {
          window.requestAnimationFrame(function () {
            toggleHeaderScrolled();
            headerTicking = false;
          });
          headerTicking = true;
        }
      },
      { passive: true }
    );
  }

  // Back to top
  var backToTop = document.getElementById("back-to-top");
  if (backToTop) {
    var toggleBackToTop = function () {
      if (window.scrollY > 480) {
        backToTop.classList.add("is-visible");
      } else {
        backToTop.classList.remove("is-visible");
      }
    };
    toggleBackToTop();

    var ticking = false;
    window.addEventListener(
      "scroll",
      function () {
        if (!ticking) {
          window.requestAnimationFrame(function () {
            toggleBackToTop();
            ticking = false;
          });
          ticking = true;
        }
      },
      { passive: true }
    );
  }

    // Scroll explicitly rather than relying on the href="#top" anchor:
    // once the URL already ends in #top (e.g. after the first click),
    // clicking an unchanged-hash link is a no-op in browsers and the
    // page simply doesn't move. This works every time, and the href
    // stays as a plain-HTML fallback if JS fails to load.
    backToTop.addEventListener("click", function (e) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
    });

  // Contact form
  var form = document.getElementById("contact-form");
  var note = document.getElementById("form-note");
  if (form && note) {
    // --- Multi-step pagination ---------------------------------------
    var steps = Array.prototype.slice.call(form.querySelectorAll(".form-step"));
    var backBtn = document.getElementById("form-back");
    var nextBtn = document.getElementById("form-next");
    var submitBtn = document.getElementById("form-submit");
    var stepLabel = document.getElementById("form-step-label");
    var stepDesc = document.getElementById("form-step-desc");
    var dots = Array.prototype.slice.call(form.querySelectorAll(".form-progress-dot"));
    var stepError1 = document.getElementById("step-error-1");
    var currentStep = 0;

    var stepDescriptions = [
      "Tell us what you\u2019re looking to get done. Select all services that apply so we can understand your project and tailor your quote.",
      "A general idea of your location and preferred time is all we need to get started. We\u2019ll use this to help coordinate your estimate.",
      "So we know who we're talking to and how to follow up.",
      "Choose a time that works best for you, and we\u2019ll make every effort to reach you during that time frame."
    ];

    var showStep = function (index) {
      steps.forEach(function (step, i) {
        step.classList.toggle("is-active", i === index);
      });
      dots.forEach(function (dot, i) {
        dot.classList.toggle("is-active", i === index);
        dot.classList.toggle("is-done", i < index);
      });
      if (stepLabel) stepLabel.textContent = "Step " + (index + 1) + " of " + steps.length;
      if (stepDesc) stepDesc.textContent = stepDescriptions[index] || "";
      if (backBtn) backBtn.hidden = index === 0;
      if (nextBtn) nextBtn.hidden = index === steps.length - 1;
      if (submitBtn) submitBtn.hidden = index !== steps.length - 1;
    };

    var validateStep = function (index) {
      var step = steps[index];
      if (!step) return true;

      // Step 1's services checkboxes: at least one has to be checked
      // (native `required` can't express "at least one of these").
      var checkboxGroup = step.querySelector(".checkbox-group");
      if (checkboxGroup) {
        var anyChecked = Array.prototype.some.call(
          checkboxGroup.querySelectorAll('input[type="checkbox"]'),
          function (cb) { return cb.checked; }
        );
        if (!anyChecked) {
          if (stepError1) stepError1.textContent = "Please select at least one service.";
          return false;
        }
        if (stepError1) stepError1.textContent = "";
      }

      // Everything else in the step uses ordinary HTML5 validation.
      var fields = Array.prototype.slice.call(step.querySelectorAll("input, textarea, select"));
      for (var i = 0; i < fields.length; i++) {
        if (!fields[i].checkValidity()) {
          fields[i].reportValidity();
          return false;
        }
      }
      return true;
    };

    if (nextBtn) {
      nextBtn.addEventListener("click", function () {
        if (!validateStep(currentStep)) return;
        currentStep = Math.min(currentStep + 1, steps.length - 1);
        showStep(currentStep);
      });
    }
    if (backBtn) {
      backBtn.addEventListener("click", function () {
        currentStep = Math.max(currentStep - 1, 0);
        showStep(currentStep);
      });
    }

    var resetSteps = function () {
      currentStep = 0;
      showStep(0);
    };

    // "Other" reveals a free-text field for what service they mean.
    var otherToggle = document.getElementById("service-other-toggle");
    var otherDetail = document.getElementById("service-other-detail");
    if (otherToggle && otherDetail) {
      otherToggle.addEventListener("change", function () {
        otherDetail.hidden = !otherToggle.checked;
        if (otherToggle.checked) otherDetail.focus();
      });
    }

    showStep(0);

    // --- Submission ----------------------------------------------------
    // The form is emailed by a Vercel serverless function (api/send-email.js),
    // which is the only place the Resend API key exists. The browser just
    // POSTs the answers to that endpoint as JSON -- no keys, no email SDK.
    var sending = false;
    var successName = document.getElementById("form-success-name");
    var successPanel = document.getElementById("form-success");
    var resetBtn = document.getElementById("form-reset");
    var submitLabel = submitBtn ? submitBtn.textContent : "";

    var setSending = function (isSending) {
      sending = isSending;
      form.setAttribute("aria-busy", String(isSending));
      if (submitBtn) {
        submitBtn.disabled = isSending;
        submitBtn.textContent = isSending ? "Sending..." : submitLabel;
      }
      if (backBtn) backBtn.disabled = isSending;
    };

    var showSuccess = function (name) {
      if (successName) successName.textContent = name ? ", " + name.split(" ")[0] : "";
      form.classList.add("is-sent");
      note.className = "form-note";
      note.textContent = "";
      if (successPanel) successPanel.focus();
    };

    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        form.classList.remove("is-sent");
        form.reset();
        if (otherDetail) otherDetail.hidden = true;
        resetSteps();
      });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (sending || !validateStep(currentStep)) return;

      note.className = "form-note";
      note.textContent = "";

      var data = new FormData(form);
      var payload = {
        services: data.getAll("services"),
        otherDetail: data.get("service-other-detail") || "",
        location: data.get("location") || "",
        estimateDate: data.get("estimate-date") || "",
        name: data.get("name") || "",
        email: data.get("email") || "",
        phone: data.get("phone") || "",
        bestTime: data.get("best-time") || "",
        botField: data.get("bot-field") || ""
      };

      setSending(true);

      fetch("/api/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (json) {
            return { ok: res.ok && json.ok === true, status: res.status, error: json.error };
          });
        })
        .then(function (result) {
          setSending(false);
          if (result.ok) {
            showSuccess(payload.name);
          } else if (result.status === 400 && result.error) {
            // Validation message from the server (e.g. a bad email address).
            note.textContent = result.error;
            note.className = "form-note error";
          } else {
            throw new Error("Send failed");
          }
        })
        .catch(function () {
          setSending(false);
          note.textContent =
            "Sorry, we couldn\u2019t send your request. Please try again, or call us at (912) 778-4126.";
          note.className = "form-note error";
        });
    });
  }

  // Hero background video: make the Vimeo iframe genuinely *cover* the hero
  // section (crop to fill, like background-size:cover), instead of relying
  // on the iframe box's own width/height, which can pillarbox/letterbox on
  // viewport ratios that don't match the source video.
  var heroVideoWrap = document.querySelector(".hero-video");
  var heroVideoFrame = heroVideoWrap && heroVideoWrap.querySelector("iframe");
  if (heroVideoWrap && heroVideoFrame) {
    var HERO_VIDEO_RATIO = 16 / 9; // native size of the uploaded clip (1920x1080)

    var fitHeroVideo = function () {
      var w = heroVideoWrap.clientWidth;
      var h = heroVideoWrap.clientHeight;
      if (!w || !h) return;

      var targetW, targetH;
      var cropsHorizontally = w / h <= HERO_VIDEO_RATIO;
      if (!cropsHorizontally) {
        // Section is relatively wider than the video: match its width,
        // let the video overflow (and get cropped) top/bottom.
        targetW = w;
        targetH = w / HERO_VIDEO_RATIO;
      } else {
        // Section is relatively taller/narrower (typical on mobile): match
        // its height, let the video overflow (and get cropped) left/right.
        targetH = h;
        targetW = h * HERO_VIDEO_RATIO;
      }

      heroVideoFrame.style.width = targetW + "px";
      heroVideoFrame.style.height = targetH + "px";
      heroVideoFrame.style.top = "50%";

      // On mobile, when the video has to be cropped left/right, anchor it
      // to the right edge instead of centering the crop -- keeps the
      // right side of the shot in frame instead of trimming both sides
      // evenly. Desktop (and any case where only top/bottom crop) stays
      // centered as before.
      var isMobile = window.innerWidth <= 720;
      if (cropsHorizontally && isMobile) {
        heroVideoFrame.style.left = "auto";
        heroVideoFrame.style.right = "0";
        heroVideoFrame.style.transform = "translateY(-50%)";
      } else {
        heroVideoFrame.style.left = "50%";
        heroVideoFrame.style.right = "auto";
        heroVideoFrame.style.transform = "translate(-50%, -50%)";
      }
    };

    fitHeroVideo();
    window.addEventListener("resize", fitHeroVideo);
    window.addEventListener("orientationchange", fitHeroVideo);
    window.addEventListener("load", fitHeroVideo);
  }

  // About section photo carousel: on mobile the two jobsite photos become
  // a swipeable, one-at-a-time slider (native horizontal scroll-snap in
  // CSS) instead of stacking diagonally on top of each other -- these dots
  // mirror the current slide and also work as tap targets.
  var aboutArt = document.getElementById("about-art");
  var aboutDots = aboutArt ? Array.prototype.slice.call(document.querySelectorAll(".about-dot")) : [];
  if (aboutArt && aboutDots.length) {
    var updateAboutDots = function () {
      var width = aboutArt.clientWidth;
      if (!width) return;
      var index = Math.round(aboutArt.scrollLeft / width);
      aboutDots.forEach(function (dot, i) {
        dot.classList.toggle("is-active", i === index);
      });
    };
    aboutArt.addEventListener(
      "scroll",
      function () {
        window.requestAnimationFrame(updateAboutDots);
      },
      { passive: true }
    );
    aboutDots.forEach(function (dot, i) {
      dot.addEventListener("click", function () {
        aboutArt.scrollTo({ left: i * aboutArt.clientWidth, behavior: "smooth" });
      });
    });
    window.addEventListener("resize", updateAboutDots);
  }
})();
