#!/usr/bin/env node
import { run } from './run.ts'

// Unconditional on purpose. npm links a bin as a symlink, so a guard comparing
// import.meta.url with argv[1] never matches, and 0.1.0 printed nothing at
// all. This file is only ever the entry point; importable code lives in run.ts.
process.exitCode = await run()
