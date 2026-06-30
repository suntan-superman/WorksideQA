#!/usr/bin/env node
const { writeDashboardData } = require("./dashboard-data");
const { log } = require("../../qa-utils/src");

const { outputPath, comparisonPath, data } = writeDashboardData();
log(`Dashboard data written: ${outputPath}`);
log(`Release comparison written: ${comparisonPath}`);
log(`Runs indexed: ${data.runs.length}`);
