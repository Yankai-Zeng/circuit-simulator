# CircuitBoard

A live, continuously-running circuit simulator built in React. Not a one-shot
DC solver — it re-solves the circuit every ~2ms of simulated time using
modified nodal analysis, with backward-Euler companion models for
capacitors and inductors, so charge curves, LC oscillation, and AC drive
actually animate in real time.

**Features**

- Resistors, capacitors, inductors, LEDs, switches, DC batteries, AC sources, ground
- A real transient engine — capacitors charge, inductors ramp, AC sources oscillate, all live
- Bendable multi-point wires with automatic crossing "hops" so overlapping wires are never ambiguous
- Drag any node to move it — every connected part's endpoint moves with it
- A live oscilloscope trace (voltage or current) for whichever part is selected
- Real reference designators (R1, C1, D1, SW1, BT1...), assigned like an actual schematic
- Two example circuits (LED indicator, RC charging) plus a blank canvas to build your own

## Local development

```bash
npm install
npm run dev
```

Opens a dev server (Vite) with hot reload at `http://localhost:5173`.

## Build

```bash
npm run build
```

Outputs a static production build to `dist/`. Preview it locally with
`npm run preview`.

## Deploying to GitHub Pages

This repo ships with a GitHub Actions workflow
(`.github/workflows/deploy.yml`) that builds and deploys automatically on
every push to `main`. One-time setup:

1. Push this repo to GitHub.
2. In the repo, go to **Settings → Pages** and set **Source** to
   **GitHub Actions** (not "Deploy from a branch").
3. Push to `main` (or run the workflow manually from the **Actions** tab).
   The site will be live at `https://<your-username>.github.io/<repo-name>/`.

**If you rename the repository**, update the `BASE_PATH` constant in
`vite.config.js` to match the new repo name exactly (GitHub Pages serves
project sites from a `/repo-name/` subpath, and Vite needs to know that at
build time or assets will 404).

## Project structure

```
index.html              Vite entry point
src/main.jsx             Mounts the component to #root
src/CircuitSimulator.jsx The entire simulator: solver, rendering, UI
src/index.css            Minimal page-level layout/reset
vite.config.js            Build config, including the GitHub Pages base path
.github/workflows/deploy.yml   CI: build + deploy to Pages on push
```

`CircuitSimulator.jsx` is currently a single file. It's organized into clear
sections (solver, formatting helpers, styling, component), but if you'd
rather split it into modules (e.g. `solver.js`, `symbols.jsx`, `Scope.jsx`),
that's a reasonable follow-up and shouldn't require touching the underlying
logic.

## License

MIT — see [LICENSE](LICENSE).
