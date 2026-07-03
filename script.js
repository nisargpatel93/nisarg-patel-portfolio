const navToggle = document.querySelector(".nav-toggle");
const siteNav = document.querySelector(".site-nav");

if (navToggle && siteNav) {
  navToggle.addEventListener("click", () => {
    const isOpen = siteNav.classList.toggle("open");
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });
}

const portrait = document.querySelector(".profile-portrait");

if (portrait) {
  document.addEventListener("mousemove", (event) => {
    if (window.innerWidth < 960) {
      return;
    }

    const moveX = (event.clientX - window.innerWidth / 2) * 0.008;
    const moveY = (event.clientY - window.innerHeight / 2) * 0.008;
    portrait.style.transform = `translate(${moveX}px, ${moveY}px) scale(1.035)`;
  });
}

const contactForm = document.querySelector("#contactForm");
const formStatus = document.querySelector("#formStatus");
const apiBaseUrl = (window.PORTFOLIO_API_BASE_URL || "").replace(/\/$/, "");
const staticFormEndpoint = window.PORTFOLIO_STATIC_FORM_ENDPOINT || "";

function buildApiUrl(path) {
  return `${apiBaseUrl}${path}`;
}

function shouldUseLocalBackend() {
  return ["localhost", "127.0.0.1"].includes(window.location.hostname) && window.location.port === "3000";
}

function shouldUseBackend() {
  return Boolean(apiBaseUrl) || shouldUseLocalBackend();
}

async function submitToBackend(payload) {
  const response = await fetch(buildApiUrl("/api/contact"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    const errorMessage = result?.error || (response.status === 404 ? "Contact service unavailable." : "Message could not be sent.");
    throw new Error(errorMessage);
  }

  return result;
}

async function submitToStaticEndpoint(payload) {
  if (!staticFormEndpoint) {
    throw new Error("Contact service unavailable.");
  }

  const response = await fetch(staticFormEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      ...payload,
      _subject: `Portfolio contact: ${payload.subject || "New message"}`,
      _template: "table",
      _captcha: "false"
    })
  });

  const result = await response.json().catch(() => null);

  if (!response.ok || result?.success === "false") {
    throw new Error(result?.message || "Message could not be sent.");
  }

  return result;
}

if (contactForm && formStatus) {
  contactForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    formStatus.className = "form-status";
    formStatus.textContent = "Sending...";

    const payload = Object.fromEntries(new FormData(contactForm).entries());

    try {
      try {
        if (shouldUseBackend()) {
          await submitToBackend(payload);
        } else {
          await submitToStaticEndpoint(payload);
        }
      } catch (error) {
        if (!staticFormEndpoint || !shouldUseBackend()) {
          throw error;
        }

        await submitToStaticEndpoint(payload);
      }

      contactForm.reset();
      formStatus.classList.add("success");
      formStatus.textContent = "Message received. Thank you for reaching out.";
    } catch (error) {
      formStatus.classList.add("error");
      if (error.message.includes("Contact service unavailable") || error.message.includes("Failed to fetch")) {
        formStatus.innerHTML = "Message delivery is temporarily unavailable. Please email <a href=\"mailto:pn747076@gmail.com\">pn747076@gmail.com</a> directly.";
      } else {
        formStatus.textContent = error.message;
      }
    }
  });
}
