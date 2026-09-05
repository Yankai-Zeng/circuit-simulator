import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import CircuitSimulator from "./CircuitSimulator.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <CircuitSimulator />
  </StrictMode>
);
