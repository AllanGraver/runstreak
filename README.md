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

Appen hostes statisk på GitHub Pages. OAuth-koden og Strava-hemmeligheden håndteres derfor af en Cloudflare Worker; hemmeligheden må aldrig lægges i frontend eller GitHub Pages. Hver bruger godkender sin egen Strava-konto. Workerens KV indeholder OAuth-tokens pr. browser/enhed og en engangs OAuth-state, der udløber efter 10 minutter. Aktivitetsdata, profilnavn og synkroniseringstid gemmes kun lokalt i brugerens browser; de gemmes ikke i Workerens KV.

1. Opret en app på [Strava API Settings](https://www.strava.com/settings/api). Brug Workerens domæne som **Authorization Callback Domain**. Den fulde callback-URL er `https://DIN-WORKER.workers.dev/auth/callback`.
2. Opret en Cloudflare KV-namespace: `npx wrangler login` og derefter `npx wrangler kv namespace create STRAVA_KV`.
3. Sæt namespace-ID'et i `wrangler.toml`. `FRONTEND_URL` er allerede sat til `https://allangraver.github.io/runstreak/`.
4. Opret Worker-hemmelighederne:

	```bash
	npx wrangler secret put STRAVA_CLIENT_ID
	npx wrangler secret put STRAVA_CLIENT_SECRET
	```
5. Udgiv Worker'en med `npx wrangler deploy`. Kopiér dens basisadresse, for eksempel `https://runstreak-strava.DIT-SUBDOMAIN.workers.dev`.
6. Tilføj en GitHub Actions repository variable med navnet `VITE_STRAVA_API_URL` og Workerens basisadresse. Kør Pages-workflowet igen.

Strava-godkendelsen beder om `read` og `activity:read_all` for at kunne finde private løbeaktiviteter. Synkronisering gennemgår Strava-aktiviteter i sider for at beregne streak og statistik. En løbedag tæller, hvis der er mindst ét løb på mindst 1,6 km den dag. Streaken tæller sammenhængende kalenderdage og bevares, hvis seneste kvalificerende løb var i går; datoer beregnes efter dansk tid.

Alle distance- og gennemsnitsmålinger bruger verificerede Strava-løb på mindst 1,6 km; aktiviteter under grænsen og andre sportstyper udelades. Ugentlig distance gælder mandag til søndag i dansk kalender, og måneds- og årstal følger dansk kalender. Livstidskilometer, Distance Explorer og antal løb bruger samme filter. Gennemsnitstempo er samlet bevægelsestid divideret med samlet distance (distancevægtet), gennemsnitsdistance er samlet distance divideret med antal kvalificerende løb, og gennemsnitligt tidsforbrug er gennemsnitlig samlet aktivitetstid pr. løb. Explorer-sammenligningerne er beregnet fra de kvalificerende livstidskilometer.

Synkroniseringsresultatet gemmes lokalt i browseren og opdateres ved første forbindelse samt ved brug af **Synkronisér**. Data deles ikke mellem mobil og pc; synkronisér separat på hver enhed. Knappen **Afbryd Strava** fjerner også den lokale aktivitetscache. Browserdata er tilgængelige for andre, der bruger samme browserprofil, men indgår ikke i det offentlige GitHub Pages-build.

Community viser top 20 fra SRI/USRSA's [danske](https://www.runeveryday.com/dk_active_streaks.php) og [globale](https://www.runeveryday.com/all_active_streaks.php) certificerede aktive streak-lister. Hver visning viser sit regelsæt under listen: den danske visning inkluderer Ultra Running Academys anbefaling om mindst 20 minutters løb inden for hvert 24-timers tidsrum, mens den globale visning fremhæver SRI/USRSA-certificering og minimumsdistancen på 1 mile (1,6 km) pr. dag. Under reglerne vises fælles anbefalinger om blandt andet roligt løb, træningspauser, løbedagbog og at passe på kroppen. Når Strava er forbundet, viser appen også fem certificerede løbere over og fem under den placering, din streak ville give ved sortering efter streakdage. Denne beregnede placering er vejledende og er ikke en officiel SRI/USRSA-placering eller certificering. Ranglistedata hentes via Worker'en og caches i KV i op til 30 minutter.
