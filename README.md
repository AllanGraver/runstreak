# RunStreak v7

Runstreak-app med Strava-forbindelse, milepæle, community-ranglister og profilstatistik.

## Lokal kørsel

```bash
npm install
npm run dev
```

## Produktionsbuild

```bash
npm run build
```

## GitHub Pages

1. Upload alle filer til et GitHub-repository med branch `main`.
2. Åbn **Settings > Pages**.
3. Vælg **GitHub Actions** under *Build and deployment*.
4. Workflowet i `.github/workflows/deploy.yml` bygger og publicerer automatisk siden.

## Aktivér Strava-forbindelsen

Appen hostes statisk på GitHub Pages. OAuth-koden og Strava-hemmeligheden håndteres derfor af en Cloudflare Worker; hemmeligheden må aldrig lægges i frontend eller GitHub Pages. Aktivitetsdata, profilnavn og synkroniseringstid gemmes kun i `localStorage` i den browser, hvor du bruger appen. De offentliggøres ikke med GitHub Pages og opbevares ikke i Workerens KV. Workerens KV indeholder OAuth-tokens pr. enhed og en engangs OAuth-state, der udløber efter 10 minutter.

1. Opret en app på [Strava API Settings](https://www.strava.com/settings/api). Brug Workerens domæne som **Authorization Callback Domain**. Den fulde callback-URL er `https://DIN-WORKER.workers.dev/auth/callback`.
2. Opret en Cloudflare KV-namespace: `npx wrangler login` og derefter `npx wrangler kv namespace create STRAVA_KV`.
3. Sæt namespace-ID'et i `wrangler.toml`, og ret `FRONTEND_URL` til din fulde GitHub Pages-adresse, inklusive repository-stien og afsluttende `/`.
4. Find dit Strava-athlete-ID i din profiladresse (`strava.com/athletes/ID`), og opret Worker-hemmelighederne:

	```bash
	npx wrangler secret put STRAVA_CLIENT_ID
	npx wrangler secret put STRAVA_CLIENT_SECRET
	npx wrangler secret put STRAVA_ATHLETE_ID
	```

	Athlete-ID'et begrænser forbindelsen til din konto, så andre Strava-konti ikke kan overtage den gemte forbindelse.
5. Udgiv Worker'en med `npx wrangler deploy`. Kopiér dens basisadresse, for eksempel `https://runstreak-strava.DIT-SUBDOMAIN.workers.dev`.
6. Tilføj en GitHub Actions repository variable med navnet `VITE_STRAVA_API_URL` og Workerens basisadresse. Kør Pages-workflowet igen.

Strava-godkendelsen beder om `read` og `activity:read_all` for at kunne finde private løbeaktiviteter. Synkronisering henter de seneste 30 aktiviteter og gemmer det seneste løb lokalt i browseren. Data deles ikke mellem mobil og pc; synkronisér separat på hver enhed. Knappen **Afbryd Strava** fjerner også den lokale aktivitetscache. Browserdata er tilgængelige for andre, der bruger samme browserprofil, men indgår ikke i det offentlige GitHub Pages-build.
