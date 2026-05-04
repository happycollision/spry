#!/usr/bin/env bun
import { selectUnits } from "./select.ts";

const arg = process.argv[2] ?? "[]";
const options = JSON.parse(arg);
const result = await selectUnits(options);
process.stdout.write(JSON.stringify(result));
