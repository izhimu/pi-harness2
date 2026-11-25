// Package main entry: defaults to the OMP adapter. Hosts load their own explicit
// entrypoint via the package.json manifests (omp.extensions -> ./extensions/omp.ts,
// pi.extensions -> ./extensions/pi.ts); this re-export only serves tooling and
// tests that import the package root.
export { default } from "./omp.js";
