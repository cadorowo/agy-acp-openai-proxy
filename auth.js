/**
 * Authentication middleware for agy-acp-openai-proxy.
 * Validates requests against PROXY_API_KEY if configured.
 */

let warnedNoAuth = false;

export function authenticateRequest(req, res, apiKey = process.env.PROXY_API_KEY) {
  // If no API key is configured, allow requests but warn once
  if (!apiKey) {
    if (!warnedNoAuth) {
      console.warn("[AUTH WARNING] PROXY_API_KEY is not set. All endpoints are publicly accessible.");
      warnedNoAuth = true;
    }
    return true;
  }

  // Preflight OPTIONS requests do not require auth
  if (req.method === "OPTIONS") {
    return true;
  }

  // Public health check
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    return true;
  }

  // Extract token from 'Authorization: Bearer <key>' or 'x-api-key'
  const authHeader = req.headers["authorization"] || "";
  let token = null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match) {
    token = match[1].trim();
  } else if (req.headers["x-api-key"]) {
    token = String(req.headers["x-api-key"]).trim();
  }

  if (!token || token !== apiKey) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "Invalid or missing API key. Provide 'Authorization: Bearer <key>' or 'x-api-key'.",
          type: "authentication_error",
          param: null,
          code: 401,
        },
      })
    );
    return false;
  }

  return true;
}
