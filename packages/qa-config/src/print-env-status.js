#!/usr/bin/env node
const { envStatus } = require("./env-status");

const status = envStatus();
for (const [product, keys] of Object.entries(status.products)) {
  process.stdout.write(`${product}\n`);
  for (const [key, value] of Object.entries(keys)) {
    process.stdout.write(`  ${key}: ${value}\n`);
  }
}

process.stdout.write("optional\n");
for (const [key, value] of Object.entries(status.optional)) {
  process.stdout.write(`  ${key}: ${value}\n`);
}

