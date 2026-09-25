/**
 * Rakazo landing page — waitlist form logic.
 * Validates email, stores signup in localStorage, shows a success state,
 * and best-effort posts to /api/waitlist (fails silently when no backend exists).
 */
(function () {
  "use strict";

  var form = document.getElementById("waitlist-form");
  var emailInput = document.getElementById("waitlist-email");
  var errorEl = document.getElementById("waitlist-error");
  var successEl = document.getElementById("waitlist-success");

  if (!form || !emailInput) return;

  var STORAGE_KEY = "rakazo_waitlist_email";

  function isValidEmail(value) {
    // Practical RFC-5322-ish check: local@domain.tld, no spaces.
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
  }

  function showError() {
    errorEl.hidden = false;
    successEl.hidden = true;
    emailInput.setAttribute("aria-invalid", "true");
    emailInput.focus();
  }

  function showSuccess() {
    errorEl.hidden = true;
    successEl.hidden = false;
    emailInput.removeAttribute("aria-invalid");
  }

  function persistLocally(email) {
    try {
      localStorage.setItem(STORAGE_KEY, email);
    } catch (e) {
      /* storage unavailable — not fatal */
    }
  }

  function postToBackend(email) {
    // Fire-and-forget: a missing backend must never break the UX.
    try {
      fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email }),
        keepalive: true
      }).catch(function () { /* fail silently */ });
    } catch (e) {
      /* fetch unavailable — fail silently */
    }
  }

  // If this visitor already signed up on this device, greet them.
  try {
    var existing = localStorage.getItem(STORAGE_KEY);
    if (existing && isValidEmail(existing)) {
      emailInput.value = existing;
      showSuccess();
    }
  } catch (e) { /* ignore */ }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var email = emailInput.value.trim();

    if (!isValidEmail(email)) {
      showError();
      return;
    }

    persistLocally(email);
    postToBackend(email);
    showSuccess();
  });

  emailInput.addEventListener("input", function () {
    if (!errorEl.hidden) errorEl.hidden = true;
  });
})();
