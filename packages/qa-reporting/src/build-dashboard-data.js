#!/usr/bin/env node
const { writeDashboardData } = require("./dashboard-data");
const { log } = require("../../qa-utils/src");

const { outputPath, data } = writeDashboardData();
log(`Dashboard data written: ${outputPath}`);
log(`Runs indexed: ${data.runs.length}`);

