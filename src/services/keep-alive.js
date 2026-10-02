// RECONSTRUCTED — referenced by server.js but missing from the uploaded repo.
// Best-guess implementation: render.yaml's RENDER_SELF_URL env var (see the
// patch) implies this is deployed on Render's free tier, which sleeps a web
// service after 15 minutes of no inbound traffic. This self-pings /health
// often enough to prevent that.
const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
let timer = null;

function startKeepAlive() {
  if (timer) return;
  const url = process.env.RENDER_SELF_URL || process.env.BACKEND_URL;
  if (!url) {
    console.warn('[keep-alive] RENDER_SELF_URL/BACKEND_URL not set — skipping self-ping');
    return;
  }

  const ping = () => {
    fetch(`${url}/health`).catch((err) => console.warn('[keep-alive] ping failed:', err.message));
  };
  timer = setInterval(ping, PING_INTERVAL_MS);
}

module.exports = { startKeepAlive };
