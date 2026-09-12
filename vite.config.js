import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves project repos from https://<username>.github.io/<repo-name>/,
// not the domain root, so Vite needs the subpath at build time. Update this
// if you rename the repo, or asset paths will 404 on the deployed site.
const BASE_PATH = "/circuit-simulator/";

export default defineConfig({
  plugins: [react()],
  base: BASE_PATH,
});
