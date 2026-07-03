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

if (contactForm && formStatus) {
  contactForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    formStatus.className = "form-status";
    formStatus.textContent = "Sending...";

    const payload = Object.fromEntries(new FormData(contactForm).entries());

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Message could not be sent.");
      }

      contactForm.reset();
      formStatus.classList.add("success");
      formStatus.textContent = "Message received. Thank you for reaching out.";
    } catch (error) {
      formStatus.classList.add("error");
      formStatus.textContent = error.message;
    }
  });
}
