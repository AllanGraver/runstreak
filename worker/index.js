const TOKEN_URL = "https://www.strava.com/oauth/token";
const API_URL = "https://www.strava.com/api/v3";
const AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const DEAUTHORIZE_URL = "https://www.strava.com/oauth/deauthorize";

const CONNECTION_PREFIX = "strava-connection:";

const LEADERBOARD_SOURCES = {
  national: "https://www.runeveryday.com/dk_active_streaks.php",
  global: "https://www.runeveryday.com/all_active_streaks.php"
};

function validDeviceId(deviceId) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId || "");
}

function validAppName(app) {
  return app === "runstreak" || app === "runhub";
}

function connectionKey(deviceId) {
  return `${CONNECTION_PREFIX}${deviceId}`;
}

function configuredOrigins(env) {
  const origins = [];

  for (const value of [env.FRONTEND_URL, env.RUNHUB_FRONTEND_URL]) {
    if (!value) continue;
    try {
      origins.push(new URL(value).origin);
    } catch {
      // requireConfig handles invalid configured URLs.
    }
  }

  return [...new Set(origins)];
}

function requestOriginAllowed(request, env) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && configuredOrigins(env).includes(origin));
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowedOrigins = configuredOrigins(env);
  const fallbackOrigin = new URL(env.FRONTEND_URL).origin;

  return {
    "Access-Control-Allow-Origin": origin && allowedOrigins.includes(origin) ? origin : fallbackOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Device-ID",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Vary: "Origin"
  };
}

function json(data, status, request, env, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: {
      ...corsHeaders(request, env),
      ...extraHeaders
    }
  });
}

function frontendForApp(env, app) {
  if (app === "runhub") {
    if (!env.RUNHUB_FRONTEND_URL) {
      throw new Error("RUNHUB_FRONTEND_URL mangler.");
    }
    return env.RUNHUB_FRONTEND_URL;
  }

  return env.FRONTEND_URL;
}

function redirectToApp(env, app, key, value) {
  const target = new URL(frontendForApp(env, app));
  target.searchParams.set(key, value);
  return Response.redirect(target.toString(), 302);
}

function requireConfig(env) {
  if (!env.FRONTEND_URL || !env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET || !env.STRAVA_KV) {
    throw new Error("Strava-serveren mangler påkrævet konfiguration.");
  }

  new URL(env.FRONTEND_URL);
  if (env.RUNHUB_FRONTEND_URL) new URL(env.RUNHUB_FRONTEND_URL);
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

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("Stravas grænse for API-kald er nået. Prøv igen senere.");
    }
    if (response.status === 401) {
      throw new Error("Strava-forbindelsen er udløbet eller tilbagekaldt. Forbind kontoen igen.");
    }
    throw new Error("Kunne ikke hente data fra Strava. Prøv at forbinde igen.");
  }

  return response.json();
}

function localDayNumber(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!match) return null;

  return Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000
  );
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

function startOfWeekDay(day) {
  const weekday = new Date(day * 86400000).getUTCDay();
  return day - ((weekday + 6) % 7);
}

function emptyDistanceStats() {
  return {
    distanceKm: 0,
    runCount: 0,
    movingTimeSeconds: 0,
    elapsedTimeSeconds: 0
  };
}

function addRunToStats(stats, activity) {
  stats.distanceKm += activity.distance / 1000;
  stats.runCount += 1;
  stats.movingTimeSeconds += activity.moving_time || 0;
  stats.elapsedTimeSeconds += activity.elapsed_time || 0;
}

async function getActivityStats(connection) {
  const currentDate = copenhagenDate();
  const today = localDayNumber(currentDate);
  const currentMonth = currentDate.slice(0, 7);
  const currentYear = currentDate.slice(0, 4);
  const weekStart = startOfWeekDay(today);

  const daysWithRuns = new Set();
  const week = emptyDistanceStats();
  const month = emptyDistanceStats();
  const year = emptyDistanceStats();
  const allTime = emptyDistanceStats();
  let latestRun = null;

  for (let page = 1; ; page += 1) {
    const activities = await stravaFetch(
      `/athlete/activities?per_page=200&page=${page}`,
      connection
    );

    if (!activities.length) break;

    for (const activity of activities) {
      const isRun =
        activity.sport_type === "Run" ||
        activity.sport_type === "TrailRun" ||
        activity.sport_type === "VirtualRun" ||
        activity.type === "Run" ||
        activity.type === "TrailRun" ||
        activity.type === "VirtualRun";

      if (!isRun || !Number.isFinite(activity.distance) || activity.distance < 1600) continue;

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

      daysWithRuns.add(day);
      addRunToStats(allTime, activity);

      if (day >= weekStart && day <= today) addRunToStats(week, activity);
      if (date.slice(0, 7) === currentMonth) addRunToStats(month, activity);
      if (date.slice(0, 4) === currentYear) addRunToStats(year, activity);
    }

    if (activities.length < 200) break;
  }

  const orderedDays = [...daysWithRuns].sort((a, b) => b - a);
  let streakDays = 0;
  let streakStartDate = null;
  let expectedDay = null;

  if (orderedDays.length && today - orderedDays[0] <= 1 && orderedDays[0] <= today) {
    for (const day of orderedDays) {
      if (expectedDay !== null && day !== expectedDay - 1) break;
      streakDays += 1;
      expectedDay = day;
      streakStartDate = new Date(day * 86400000).toISOString().slice(0, 10);
    }
  }

  return {
    streakDays,
    streakStartDate,
    latestRun,
    activityStats: {
      week,
      month,
      year,
      allTime: {
        ...allTime,
        averageDistanceKm: allTime.runCount ? allTime.distanceKm / allTime.runCount : 0,
        averagePaceSecondsPerKm: allTime.distanceKm
          ? allTime.movingTimeSeconds / allTime.distanceKm
          : 0,
        averageDurationSeconds: allTime.runCount
          ? allTime.elapsedTimeSeconds / allTime.runCount
          : 0
      }
    }
  };
}

function decodeHtmlText(value) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;| /gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&([a-z]+);/g, (entity, name) => ({
      aelig: "æ", AElig: "Æ", oslash: "ø", Oslash: "Ø", aring: "å", Aring: "Å",
      auml: "ä", Auml: "Ä", ouml: "ö", Ouml: "Ö", uuml: "ü", Uuml: "Ü",
      eacute: "é", Eacute: "É", egrave: "è", Egrave: "È", ccedil: "ç", Ccedil: "Ç"
    }[name] || entity))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function parseLeaderboard(html) {
  const entries = [];

  for (const [, body] of html.matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/gi)) {
    for (const [, row] of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
        .map(([, cell]) => decodeHtmlText(cell));

      if (cells.length < 7 || !/^\d+$/.test(cells[0])) continue;

      const streak = cells[6].match(/^([\d,.]+)\s*(?:dage|days)\b/i);
      const streakDays = streak ? Number(streak[1].replace(/[,.]/g, "")) : NaN;

      if (!cells[1] || !Number.isSafeInteger(streakDays)) continue;
      entries.push({ rank: Number(cells[0]), name: cells[1], streakDays });
    }
  }

  return entries;
}

async function getLeaderboard(env, scope, streakDays) {
  const sourceUrl = LEADERBOARD_SOURCES[scope];
  if (!sourceUrl) throw new Error("Ukendt ranglistetype.");

  const cacheKey = `leaderboard:v3:${scope}`;
  const cached = await env.STRAVA_KV.get(cacheKey, "json");
  let leaderboard = cached;

  if (!leaderboard) {
    const response = await fetch(sourceUrl, {
      headers: { Accept: "text/html" },
      cf: { cacheTtl: 900, cacheEverything: true }
    });

    if (!response.ok) {
      throw new Error("Den officielle rangliste kunne ikke hentes lige nu.");
    }

    const entries = parseLeaderboard(await response.text());
    if (entries.length === 0) {
      throw new Error("Den officielle rangliste havde et ukendt format.");
    }

    leaderboard = {
      scope,
      entries,
      sourceUrl,
      fetchedAt: new Date().toISOString()
    };

    await env.STRAVA_KV.put(cacheKey, JSON.stringify(leaderboard), {
      expirationTtl: 1800
    });
  }

  const top = [...leaderboard.entries]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 20);

  if (!Number.isSafeInteger(streakDays) || streakDays < 1) {
    return { ...leaderboard, entries: top, estimatedPlacement: null };
  }

  const sortedByStreak = [...leaderboard.entries]
    .sort((a, b) => b.streakDays - a.streakDays || a.rank - b.rank);

  const above = sortedByStreak
    .filter(entry => entry.streakDays > streakDays)
    .slice(-5);

  const below = sortedByStreak
    .filter(entry => entry.streakDays <= streakDays)
    .slice(0, 5);

  const rank = sortedByStreak.filter(entry => entry.streakDays > streakDays).length + 1;

  const nearby = [
    ...above.map((entry, index) => ({
      ...entry,
      comparisonRank: rank - above.length + index
    })),
    {
      name: "Din Strava-streak",
      streakDays,
      comparisonRank: rank,
      isUser: true
    },
    ...below.map((entry, index) => ({
      ...entry,
      comparisonRank: rank + index + 1
    }))
  ];

  return {
    ...leaderboard,
    entries: top,
    estimatedPlacement: { rank, nearby }
  };
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");

  let stateData = null;
  if (state) {
    stateData = await env.STRAVA_KV.get(`oauth-state:${state}`, "json");

    if (!stateData) {
      const legacyDeviceId = await env.STRAVA_KV.get(`oauth-state:${state}`);
      if (validDeviceId(legacyDeviceId)) {
        stateData = { deviceId: legacyDeviceId, app: "runstreak" };
      }
    }
  }

  const app = validAppName(stateData?.app) ? stateData.app : "runstreak";

  if (url.searchParams.has("error")) {
    if (state) await env.STRAVA_KV.delete(`oauth-state:${state}`);
    return redirectToApp(
      env,
      app,
      "strava_error",
      "Strava-forbindelsen blev annulleret."
    );
  }

  const code = url.searchParams.get("code");
  const deviceId = stateData?.deviceId;

  if (!state || !code || !validDeviceId(deviceId)) {
    return redirectToApp(
      env,
      app,
      "strava_error",
      "Strava-login kunne ikke valideres. Prøv igen."
    );
  }

  await env.STRAVA_KV.delete(`oauth-state:${state}`);

  try {
    const token = await exchangeToken({
      grant_type: "authorization_code",
      code
    }, env);

    await env.STRAVA_KV.put(
      connectionKey(deviceId),
      JSON.stringify({
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: token.expires_at,
        athleteId: token.athlete?.id ?? null,
        athleteName: token.athlete
          ? `${token.athlete.firstname || ""} ${token.athlete.lastname || ""}`.trim()
          : null,
        connectedApp: app,
        connectedAt: new Date().toISOString()
      })
    );

    return redirectToApp(env, app, "strava", "connected");
  } catch {
    return redirectToApp(
      env,
      app,
      "strava_error",
      "Strava-forbindelsen fejlede. Prøv igen."
    );
  }
}

function parsePositiveInteger(value, fallback, maximum) {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function optionalEpoch(value) {
  if (value === null || value === "") return null;
  if (!/^\d+$/.test(value)) return null;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validActivityId(value) {
  return /^\d+$/.test(value || "");
}

function runhubActivitySummary(activity) {
  return {
    id: activity.id,
    name: activity.name,
    type: activity.type,
    sportType: activity.sport_type,
    startDate: activity.start_date,
    startDateLocal: activity.start_date_local,
    timezone: activity.timezone,
    distanceMeters: activity.distance,
    distanceKm: Number.isFinite(activity.distance) ? activity.distance / 1000 : null,
    movingTimeSeconds: activity.moving_time,
    elapsedTimeSeconds: activity.elapsed_time,
    totalElevationGainMeters: activity.total_elevation_gain,
    elevHighMeters: activity.elev_high ?? null,
    elevLowMeters: activity.elev_low ?? null,
    averageSpeedMetersPerSecond: activity.average_speed ?? null,
    maxSpeedMetersPerSecond: activity.max_speed ?? null,
    averageHeartRate: activity.average_heartrate ?? null,
    maxHeartRate: activity.max_heartrate ?? null,
    hasHeartRate: activity.has_heartrate ?? false,
    averageCadence: activity.average_cadence ?? null,
    averageWatts: activity.average_watts ?? null,
    maxWatts: activity.max_watts ?? null,
    weightedAverageWatts: activity.weighted_average_watts ?? null,
    deviceWatts: activity.device_watts ?? null,
    kilojoules: activity.kilojoules ?? null,
    calories: activity.calories ?? null,
    sufferScore: activity.suffer_score ?? null,
    workoutType: activity.workout_type ?? null,
    gearId: activity.gear_id ?? null,
    trainer: activity.trainer ?? false,
    commute: activity.commute ?? false,
    manual: activity.manual ?? false,
    private: activity.private ?? false,
    achievementCount: activity.achievement_count ?? 0,
    kudosCount: activity.kudos_count ?? 0,
    commentCount: activity.comment_count ?? 0,
    athleteCount: activity.athlete_count ?? 0,
    photoCount: activity.total_photo_count ?? 0,
    map: activity.map
      ? {
          id: activity.map.id ?? null,
          summaryPolyline: activity.map.summary_polyline ?? null
        }
      : null
  };
}

async function requireConnection(request, env) {
  const deviceId = request.headers.get("X-Device-ID");

  if (!validDeviceId(deviceId)) {
    return {
      error: json({ error: "Ugyldig lokal enhedsnøgle." }, 400, request, env)
    };
  }

  const connection = await getConnection(env, deviceId);

  if (!connection) {
    return {
      error: json({ error: "Forbind først din Strava-konto." }, 401, request, env)
    };
  }

  return { deviceId, connection };
}

async function handleRunHubApi(request, env, url) {
  const auth = await requireConnection(request, env);
  if (auth.error) return auth.error;

  const { connection } = auth;

  if (url.pathname === "/api/runhub/athlete" && request.method === "GET") {
    const athlete = await stravaFetch("/athlete", connection);

    return json({
      athlete: {
        id: athlete.id,
        username: athlete.username ?? null,
        firstname: athlete.firstname ?? null,
        lastname: athlete.lastname ?? null,
        city: athlete.city ?? null,
        state: athlete.state ?? null,
        country: athlete.country ?? null,
        sex: athlete.sex ?? null,
        premium: athlete.premium ?? false,
        summit: athlete.summit ?? false,
        profileMedium: athlete.profile_medium ?? null,
        profile: athlete.profile ?? null,
        createdAt: athlete.created_at ?? null,
        updatedAt: athlete.updated_at ?? null
      }
    }, 200, request, env);
  }

  if (url.pathname === "/api/runhub/activities" && request.method === "GET") {
    const page = parsePositiveInteger(url.searchParams.get("page"), 1, 100000);
    const perPage = parsePositiveInteger(url.searchParams.get("perPage"), 50, 200);
    const before = optionalEpoch(url.searchParams.get("before"));
    const after = optionalEpoch(url.searchParams.get("after"));
    const sportType = url.searchParams.get("sportType");

    const params = new URLSearchParams({
      page: String(page),
      per_page: String(perPage)
    });

    if (before !== null) params.set("before", String(before));
    if (after !== null) params.set("after", String(after));

    const activities = await stravaFetch(
      `/athlete/activities?${params.toString()}`,
      connection
    );

    const filteredActivities = sportType
      ? activities.filter(activity =>
          activity.sport_type === sportType || activity.type === sportType
        )
      : activities;

    return json({
      page,
      perPage,
      received: activities.length,
      returned: filteredActivities.length,
      hasMore: activities.length === perPage,
      activities: filteredActivities.map(runhubActivitySummary)
    }, 200, request, env);
  }

  const activityMatch = url.pathname.match(
    /^\/api\/runhub\/activity\/(\d+)(?:\/(streams|laps|zones))?$/
  );

  if (activityMatch && request.method === "GET") {
    const activityId = activityMatch[1];
    const resource = activityMatch[2] || "detail";

    if (!validActivityId(activityId)) {
      return json({ error: "Ugyldigt aktivitets-ID." }, 400, request, env);
    }

    if (resource === "detail") {
      const includeAllEfforts = url.searchParams.get("includeAllEfforts") === "true";
      const activity = await stravaFetch(
        `/activities/${activityId}?include_all_efforts=${includeAllEfforts ? "true" : "false"}`,
        connection
      );

      return json({ activity }, 200, request, env);
    }

    if (resource === "streams") {
      const allowedStreamTypes = new Set([
        "time",
        "distance",
        "latlng",
        "altitude",
        "velocity_smooth",
        "heartrate",
        "cadence",
        "watts",
        "temp",
        "moving",
        "grade_smooth"
      ]);

      const requestedKeys = (
        url.searchParams.get("keys") ||
        "time,distance,altitude,velocity_smooth,heartrate,cadence,watts,moving,grade_smooth"
      )
        .split(",")
        .map(value => value.trim())
        .filter(value => allowedStreamTypes.has(value));

      const uniqueKeys = [...new Set(requestedKeys)];

      if (!uniqueKeys.length) {
        return json(
          { error: "Der blev ikke valgt nogen gyldige streamtyper." },
          400,
          request,
          env
        );
      }

      const streams = await stravaFetch(
        `/activities/${activityId}/streams?keys=${encodeURIComponent(uniqueKeys.join(","))}&key_by_type=true`,
        connection
      );

      return json({ activityId, keys: uniqueKeys, streams }, 200, request, env);
    }

    if (resource === "laps") {
      const laps = await stravaFetch(`/activities/${activityId}/laps`, connection);
      return json({ activityId, laps }, 200, request, env);
    }

    if (resource === "zones") {
      const zones = await stravaFetch(`/activities/${activityId}/zones`, connection);
      return json({ activityId, zones }, 200, request, env);
    }
  }

  return json({ error: "Ukendt RunHub-endpoint." }, 404, request, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      requireConfig(env);

      if (url.pathname === "/auth/start" && request.method === "GET") {
        const deviceId = url.searchParams.get("device");
        const requestedApp = url.searchParams.get("app");
        const app = validAppName(requestedApp) ? requestedApp : "runstreak";

        if (!validDeviceId(deviceId)) {
          return redirectToApp(
            env,
            app,
            "strava_error",
            "Enhedens lokale nøgle er ugyldig."
          );
        }

        if (app === "runhub" && !env.RUNHUB_FRONTEND_URL) {
          return redirectToApp(
            env,
            "runstreak",
            "strava_error",
            "RunHub er ikke konfigureret på serveren."
          );
        }

        const state = crypto.randomUUID();

        await env.STRAVA_KV.put(
          `oauth-state:${state}`,
          JSON.stringify({
            deviceId,
            app,
            createdAt: new Date().toISOString()
          }),
          { expirationTtl: 600 }
        );

        const redirectUri = new URL("/auth/callback", url.origin).toString();
        const authorizeUrl = new URL(AUTHORIZE_URL);

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
        const headers = corsHeaders(request, env);

        if (request.method === "OPTIONS") {
          if (!requestOriginAllowed(request, env)) {
            return new Response(null, { status: 403, headers });
          }
          return new Response(null, { status: 204, headers });
        }

        if (!requestOriginAllowed(request, env)) {
          return json({ error: "Ugyldig app-origin." }, 403, request, env);
        }

        if (url.pathname.startsWith("/api/runhub/")) {
          return handleRunHubApi(request, env, url);
        }

        // Existing RunStreak API remains unchanged in path and response shape.
        const deviceId = request.headers.get("X-Device-ID");

        if (!validDeviceId(deviceId)) {
          return json({ error: "Ugyldig lokal enhedsnøgle." }, 400, request, env);
        }

        if (url.pathname === "/api/leaderboard" && request.method === "GET") {
          const scope = url.searchParams.get("scope");

          if (scope !== "national" && scope !== "global") {
            return json(
              { error: "Vælg national eller global rangliste." },
              400,
              request,
              env
            );
          }

          const rawStreakDays = url.searchParams.get("streakDays");
          const streakDays = rawStreakDays && /^\d+$/.test(rawStreakDays)
            ? Number(rawStreakDays)
            : null;

          if (streakDays !== null && !Number.isSafeInteger(streakDays)) {
            return json(
              { error: "Streakdage skal være et gyldigt heltal." },
              400,
              request,
              env
            );
          }

          return json(
            await getLeaderboard(env, scope, streakDays),
            200,
            request,
            env
          );
        }

        if (url.pathname === "/api/status" && request.method === "GET") {
          const connection = await getConnection(env, deviceId);
          return json({ connected: Boolean(connection) }, 200, request, env);
        }

        if (url.pathname === "/api/sync" && request.method === "GET") {
          const connection = await getConnection(env, deviceId);

          if (!connection) {
            return json(
              { error: "Forbind først din Strava-konto." },
              401,
              request,
              env
            );
          }

          const [stats, athlete] = await Promise.all([
            getActivityStats(connection),
            stravaFetch("/athlete", connection)
          ]);

          return json({
            athleteName: `${athlete.firstname} ${athlete.lastname}`.trim(),
            ...stats
          }, 200, request, env);
        }

        if (url.pathname === "/api/disconnect" && request.method === "POST") {
          const connection = await getConnection(env, deviceId);

          if (connection) {
            await fetch(DEAUTHORIZE_URL, {
              method: "POST",
              headers: { Authorization: `Bearer ${connection.accessToken}` }
            }).catch(() => null);
          }

          await env.STRAVA_KV.delete(connectionKey(deviceId));
          return json({ connected: false }, 200, request, env);
        }

        return json({ error: "Ukendt Strava-endpoint." }, 404, request, env);
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ukendt serverfejl.";
      return json({ error: message }, 500, request, env);
    }
  }
};
