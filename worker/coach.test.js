import assert from "node:assert/strict";
import test from "node:test";
import worker from "./index.js";

const deviceId = "123e4567-e89b-42d3-a456-426614174000";
const endpoint = "https://runstreak.allangraver.workers.dev/api/runhub/coach";
const validPayload = {
  goal: {
    distanceKm: 21.1,
    raceDate: "2026-12-01",
    weeksUntilRace: 6,
    level: "build",
  },
  plan: {
    distanceKm: 21.1,
    level: "build",
    upcomingWeeklyTargetsKm: [30, 32, 34],
  },
  weeks: [
    {
      weekStart: "2026-10-19",
      runCount: 3,
      distanceKm: 24,
      longestRunKm: 12,
      averagePaceSecondsPerKm: 360,
      activityName: "must not reach AI",
    },
  ],
};

function createEnvironment({ withAi = true } = {}) {
  const calls = [];
  const env = {
    FRONTEND_URL: "https://allangraver.github.io/runstreak/",
    RUNHUB_FRONTEND_URL: "https://allangraver.github.io/hlm_runhub/",
    STRAVA_CLIENT_ID: "test-client",
    STRAVA_CLIENT_SECRET: "test-secret",
    STRAVA_KV: {
      async get(key) {
        assert.equal(key, `strava-connection:${deviceId}`);
        return {
          accessToken: "test-token",
          refreshToken: "test-refresh",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        };
      },
    },
  };
  if (withAi) {
    env.AI = {
      async run(model, input) {
        calls.push({ model, input });
        return { response: "Fortsæt med en rolig progression." };
      },
    };
  }
  return { env, calls };
}

function createRequest(payload) {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      Origin: "https://allangraver.github.io",
      "Content-Type": "application/json",
      "X-Device-ID": deviceId,
    },
    body: JSON.stringify(payload),
  });
}

test("coach endpoint analyzes validated weekly summaries only", async () => {
  const { env, calls } = createEnvironment();
  const response = await worker.fetch(createRequest(validPayload), env);

  assert.equal(response.status, 200);
  assert.equal((await response.json()).analysis, "Fortsæt med en rolig progression.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "@cf/meta/llama-3.1-8b-instruct");
  assert.match(calls[0].input.messages[1].content, /"distanceKm":24/);
  assert.doesNotMatch(calls[0].input.messages[1].content, /must not reach AI/);
});

test("coach endpoint rejects malformed summaries before calling AI", async () => {
  const { env, calls } = createEnvironment();
  const response = await worker.fetch(
    createRequest({ ...validPayload, weeks: [{ ...validPayload.weeks[0], distanceKm: -1 }] }),
    env
  );

  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("coach endpoint reports missing Workers AI binding", async () => {
  const { env, calls } = createEnvironment({ withAi: false });
  const response = await worker.fetch(createRequest(validPayload), env);

  assert.equal(response.status, 503);
  assert.equal(calls.length, 0);
});
