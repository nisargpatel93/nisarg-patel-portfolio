const navToggle = document.querySelector(".nav-toggle");
const siteNav = document.querySelector(".site-nav");

const updateScrollState = () => {
  document.body.classList.toggle("has-scrolled", window.scrollY > 12);
};

updateScrollState();
window.addEventListener("scroll", updateScrollState, { passive: true });

if (navToggle && siteNav) {
  const closeNavigation = () => {
    siteNav.classList.remove("open");
    navToggle.classList.remove("is-open");
    navToggle.setAttribute("aria-expanded", "false");
  };

  navToggle.addEventListener("click", () => {
    const isOpen = siteNav.classList.toggle("open");
    navToggle.classList.toggle("is-open", isOpen);
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });

  siteNav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", closeNavigation);
  });

  document.addEventListener("click", (event) => {
    if (!siteNav.classList.contains("open")) {
      return;
    }

    if (siteNav.contains(event.target) || navToggle.contains(event.target)) {
      return;
    }

    closeNavigation();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeNavigation();
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 860) {
      closeNavigation();
    }
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

const animatedElements = document.querySelectorAll(
  ".section, .page-hero, .card, .metric, .tag-list span, .timeline-item, .document-card, .project-visual"
);

if (animatedElements.length) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  animatedElements.forEach((element, index) => {
    element.classList.add("reveal");

    if (element.classList.contains("portrait-panel") || element.classList.contains("contact-card")) {
      element.classList.add("reveal-right");
    }

    element.style.setProperty("--reveal-delay", `${Math.min(index % 6, 5) * 55}ms`);
  });

  if (reduceMotion || !("IntersectionObserver" in window)) {
    animatedElements.forEach((element) => element.classList.add("is-visible"));
  } else {
    const revealObserver = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            return;
          }

          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      {
        rootMargin: "0px 0px -12% 0px",
        threshold: 0.12
      }
    );

    animatedElements.forEach((element) => revealObserver.observe(element));
  }
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
