#!/usr/bin/env node
import { run } from './cli/run.ts'

process.exitCode = await run()
