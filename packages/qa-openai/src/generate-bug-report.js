#!/usr/bin/env node
const { writeBugReport } = require("./bug-report-generator");
const { log } = require("../../qa-utils/src");

const outputPath = writeBugReport(process.argv[2]);
log(`Bug report written: ${outputPath}`);

