# Circuit Simulator

A real-time, browser-based circuit simulator built with React and SVG. Wire up resistors, capacitors, inductors, LEDs, switches, and sources on a grid, and watch the circuit solve continuously — capacitors actually charge, inductors actually ramp, AC sources actually oscillate — instead of computing a single static answer.

## Why This Exists

Most simple circuit simulators solve a circuit once and display the result: a voltage, a current, done. This one re-solves the whole circuit a couple thousand times a second, so state actually evolves in front of you rather than being inferred from a single snapshot. It's the same underlying math — modified nodal analysis with backward-Euler discretization for reactive components — just run continuously instead of once per interaction.

## Features

- **Live simulation** — the circuit is re-solved continuously while you build, not on a "run" button press
- **Component library** — resistors, capacitors, inductors, LEDs, switches, DC batteries, AC sources, and ground
- **Multi-point wires** — click through several points to route a wire around other elements
- **Automatic crossover hops** — wires that cross without connecting are drawn with a visual hop, so overlap is never ambiguous with a real junction
- **Draggable nodes** — grab any connection point and everything wired to it moves with it, since a node belongs to the circuit, not to one part
- **Pan & zoom** — scroll to zoom toward the cursor, drag empty space to pan; camera state persists across board clears and example loads
- **Built-in oscilloscope** — select any node or component and trace its voltage or current over the last few seconds of simulated time
- **Example circuits** — a basic LED indicator and an RC charging circuit (switch left open, so you can close it and watch the capacitor charge live)

## How It Works

The simulator formulates the circuit as a modified nodal analysis (MNA) system at every timestep. Capacitors and inductors are replaced with their backward-Euler companion models (a resistor plus a history-dependent current or voltage source), so the system stays a linear solve at each step even though the overall behavior is transient. The result is integrated forward at a fixed internal timestep, decoupled from the render's frame rate, with a step-count cap per frame so a backgrounded tab doesn't trigger a large catch-up burst on return.

## Getting Started

```bash
# install dependencies
npm install

# start the dev server
npm run dev

# build for production
npm run build
```

## [Live Demo](https://yankai-zeng.github.io/circuit-simulator/)

