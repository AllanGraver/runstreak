const TOKEN_URL = "https://www.strava.com/oauth/token";
const API_URL = "https://www.strava.com/api/v3";
const CONNECTION_PREFIX = "strava-connection:";

function validDeviceId(deviceId) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId || "");
}

function connectionKey(deviceId) {
  return `${CONNECTION_PREFIX}${deviceId}`;
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": new URL(env.FRONTEND_URL).origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Device-ID",
    "Cache-Control": "no-store",
    Vary: "Origin"
  };
}

function json(data, status, env) {
  return Response.json(data, { status, headers: corsHeaders(env) });
}

function redirectToApp(env, key, value) {
  const target = new URL(env.FRONTEND_URL);
  target.searchParams.set(key, value);
  return Response.redirect(target.toString(), 302);
}

function requireConfig(env) {
  if (!env.FRONTEND_URL || !env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET || !env.STRAVA_KV) {
    throw new Error("Strava-serveren mangler påkrævet konfiguration.");
  }
}

async function exchangeToken(body, env) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      ...body
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error("Strava kunne ikke godkende forbindelsen.");
  return data;
}

async function getConnection(env, deviceId) {
  const connection = await env.STRAVA_KV.get(connectionKey(deviceId), "json");
  if (!connection) return null;

  if (connection.expiresAt <= Math.floor(Date.now() / 1000) + 120) {
    const refreshed = await exchangeToken({
      grant_type: "refresh_token",
      refresh_token: connection.refreshToken
    }, env);
    connection.accessToken = refreshed.access_token;
    connection.refreshToken = refreshed.refresh_token;
    connection.expiresAt = refreshed.expires_at;
    await env.STRAVA_KV.put(connectionKey(deviceId), JSON.stringify(connection));
  }
  return connection;
}

async function stravaFetch(path, connection) {
  const response = await fetch(`${API_URL}${path}`, {
    headers: { Authorization: `Bearer ${connection.accessToken}` }
  });
  if (!response.ok) throw new Error("Kunne ikke hente data fra Strava. Prøv at forbinde igen.");
  return response.json();
}

function localDayNumber(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000);
}

function copenhagenDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Copenhagen",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function getRunStreak(connection) {
  const today = localDayNumber(copenhagenDate());
  let expectedDay = null;
  let streakDays = 0;
  let streakStartDate = null;
  let latestRun = null;

  for (let page = 1; ; page += 1) {
    const activities = await stravaFetch(`/athlete/activities?per_page=200&page=${page}`, connection);
    if (!activities.length) break;

    for (const activity of activities) {
      const isRun = activity.sport_type === "Run" || activity.sport_type === "TrailRun" || activity.type === "Run" || activity.type === "VirtualRun";
      if (!isRun || activity.distance < 1600) continue;

      const date = activity.start_date_local?.slice(0, 10);
      const day = localDayNumber(date);
      if (day === null) continue;

      if (!latestRun) {
        latestRun = {
          name: activity.name,
          distanceKm: (activity.distance / 1000).toFixed(1).replace(".", ","),
          date: activity.start_date_local
        };
      }

      if (expectedDay === null) {
        if (today - day > 1 || day > today) {
          return { streakDays: 0, streakStartDate: null, latestRun };
        }
        expectedDay = day;
        streakDays = 1;
        streakStartDate = date;
      } else if (day === expectedDay) {
        continue;
      } else if (day === expectedDay - 1) {
        expectedDay = day;
        streakDays += 1;
        streakStartDate = date;
      } else if (day < expectedDay - 1) {
        return { streakDays, streakStartDate, latestRun };
      }
    }

    if (activities.length < 200) break;
  }

  return { streakDays, streakStartDate, latestRun };
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.has("error")) {
    return redirectToApp(env, "strava_error", "Strava-forbindelsen blev annulleret.");
  }

  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const deviceId = state ? await env.STRAVA_KV.get(`oauth-state:${state}`) : null;
  if (!state || !code || !validDeviceId(deviceId)) {
    return redirectToApp(env, "strava_error", "Strava-login kunne ikke valideres. Prøv igen.");
  }
  await env.STRAVA_KV.delete(`oauth-state:${state}`);

  try {
    const token = await exchangeToken({ grant_type: "authorization_code", code }, env);
    await env.STRAVA_KV.put(connectionKey(deviceId), JSON.stringify({
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: token.expires_at
    }));
    return redirectToApp(env, "strava", "connected");
  } catch {
    return redirectToApp(env, "strava_error", "Strava-forbindelsen fejlede. Prøv igen.");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      requireConfig(env);

      if (url.pathname === "/auth/start" && request.method === "GET") {
        const deviceId = url.searchParams.get("device");
        if (!validDeviceId(deviceId)) return redirectToApp(env, "strava_error", "Enhedens lokale nøgle er ugyldig.");
        const state = crypto.randomUUID();
        await env.STRAVA_KV.put(`oauth-state:${state}`, deviceId, { expirationTtl: 600 });
        const redirectUri = new URL("/auth/callback", url.origin).toString();
        const authorizeUrl = new URL("https://www.strava.com/oauth/authorize");
        authorizeUrl.search = new URLSearchParams({
          client_id: env.STRAVA_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          approval_prompt: "auto",
          scope: "read,activity:read_all",
          state
        }).toString();
        return Response.redirect(authorizeUrl.toString(), 302);
      }

      if (url.pathname === "/auth/callback" && request.method === "GET") {
        return handleCallback(request, env);
      }

      if (url.pathname.startsWith("/api/")) {
        const headers = corsHeaders(env);
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
        if (request.headers.get("Origin") !== new URL(env.FRONTEND_URL).origin) {
          return json({ error: "Ugyldig app-origin." }, 403, env);
        }
        const deviceId = request.headers.get("X-Device-ID");
        if (!validDeviceId(deviceId)) return json({ error: "Ugyldig lokal enhedsnøgle." }, 400, env);

        if (url.pathname === "/api/status" && request.method === "GET") {
          const connection = await getConnection(env, deviceId);
          return json({ connected: Boolean(connection) }, 200, env);
        }

        if (url.pathname === "/api/sync" && request.method === "GET") {
          const connection = await getConnection(env, deviceId);
          if (!connection) return json({ error: "Forbind først din Strava-konto." }, 401, env);
          const [streak, athlete] = await Promise.all([
            getRunStreak(connection),
            stravaFetch("/athlete", connection)
          ]);
          return json({
            athleteName: `${athlete.firstname} ${athlete.lastname}`.trim(),
            ...streak
          }, 200, env);
        }

        if (url.pathname === "/api/disconnect" && request.method === "POST") {
          const connection = await getConnection(env, deviceId);
          if (connection) {
            await fetch("https://www.strava.com/oauth/deauthorize", {
              method: "POST",
              headers: { Authorization: `Bearer ${connection.accessToken}` }
            }).catch(() => null);
          }
          await env.STRAVA_KV.delete(connectionKey(deviceId));
          return json({ connected: false }, 200, env);
        }

        return json({ error: "Ukendt Strava-endpoint." }, 404, env);
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ukendt serverfejl.";
      return json({ error: message }, 500, env);
    }
  }
};