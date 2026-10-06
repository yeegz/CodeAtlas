#!/usr/bin/env node
// The evidence packages are published inside this workspace as TypeScript
// sources, so the executable registers a TypeScript loader before importing
// them. A later distribution plan can replace this with compiled output
// without changing the command surface.
import { register } from "tsx/esm/api";

register();

const { main } = await import("../src/index.ts");

process.exitCode = await main(process.argv.slice(2));
