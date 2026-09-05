import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves a project site (not a user/org root site) from
// https://<username>.github.io/<repo-name>/ — Vite needs to know that
// subpath at build time so the built HTML/JS/CSS reference assets
// correctly. If you rename the repo, update this to match exactly
// (leading and trailing slash both matter).
const BASE_PATH = "/circuit-simulator/";

export default defineConfig({
  plugins: [react()],
  base: BASE_PATH,
});
