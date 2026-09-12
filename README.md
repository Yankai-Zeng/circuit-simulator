# circuit-simulator

I built this because I wanted a circuit simulator that actually felt alive
instead of just spitting out a static answer. Most simple simulators solve
a circuit once and show you the result - a voltage, a current, done. This
one keeps solving, a couple thousand times a second, so a capacitor
actually charges up in front of you, an inductor's current actually ramps,
an AC source actually oscillates. It's the same underlying math, modified
nodal analysis with backward-Euler models for the capacitors and inductors,
just run continuously instead of once.

The parts are resistors, capacitors, inductors, LEDs, switches, DC
batteries, AC sources, and ground. You wire them together on a grid, and
it's solving the whole thing live the entire time you're building it, not
just when you hit some "run" button.

Wires aren't limited to a single straight segment. You can click through a
few points to bend one around something, and if two wires end up crossing
on the board without actually being connected there, it draws a small hop
so you're not left guessing whether they're wired together or just
overlapping. You can also grab any connection point and drag it somewhere
else - everything attached at that point follows along, since a node isn't
really owned by one part, it's just wherever things happen to meet.

The board is zoomable and pannable - scroll to zoom toward wherever the
cursor is, drag on empty space to pan. Neither resets when the board is
cleared or a different example is loaded, since the camera position isn't
really part of the circuit, it's just where you happen to be looking.

There's a small oscilloscope in the side panel. Select anything and it
traces voltage or current over the last few seconds, so you can actually
watch a charge curve bend or an AC waveform oscillate instead of inferring
it from a color changing somewhere.

Two example circuits are built in to start from - a basic LED indicator,
and an RC charging circuit with the switch left open so you can close it
yourself and watch the capacitor charge in real time.

It's a single React component, rendered as SVG, built with Vite. No
backend, nothing calling out anywhere - the whole simulation runs
client-side, in the browser, on your machine.

## License

MIT, do whatever you want with it.
