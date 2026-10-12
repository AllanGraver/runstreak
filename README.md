# RunStreak v7

Klikbar React-prototype til runstreakere med Strava-demo, milepæle, community-ranglister og profilstatistik.

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

## Vigtigt

Strava-forbindelsen er en tydeligt markeret demo. Der foretages ingen rigtig login- eller API-forbindelse.
