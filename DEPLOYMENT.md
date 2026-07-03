# Deployment Notes

## Static site

GitHub Pages can serve the portfolio pages, CSS, and JavaScript, but it cannot run `server.js`.

When `window.PORTFOLIO_API_BASE_URL` is empty in `config.js`, the contact form uses the static FormSubmit email fallback:

```js
window.PORTFOLIO_STATIC_FORM_ENDPOINT = "https://formsubmit.co/ajax/pn747076@gmail.com";
```

This sends email only. It does not send SMS.

## Backend with SMS

To save messages in the backend and send SMS, deploy the Node app to a backend host such as Render, Railway, Fly.io, or a VPS. Then set these environment variables on that backend host:

```text
PORT=3000
CORS_ALLOW_ORIGIN=https://nisargpatel93.github.io
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_FROM=your_twilio_phone_number
SMS_TO=+919313708082
```

After the backend has a public URL, update `config.js`:

```js
window.PORTFOLIO_API_BASE_URL = "https://your-backend-url";
```

Then the contact form will use `/api/contact`, save the message, and send the SMS notification.
