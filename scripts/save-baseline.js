'use strict';

// Saves the current consolidated summary as the performance baseline used by
// report-summary's regression comparison. Fails fast if the summary is missing,
// unreadable, or contains no usable metrics.

const fs = require('fs');
const path = require('path');
const config = require('../src/config');

function rel(p) {
  return path.relative(config.projectRoot, p).replace(/\\/g, '/');
}

function main() {
  const source = config.paths.summaryJson;
  if (!fs.existsSync(source)) {
    console.error(`Baseline not saved: ${rel(source)} does not exist. Run "npm run report" first.`);
    process.exitCode = 1;
    return;
  }

  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch (err) {
    console.error(`Baseline not saved: could not parse ${rel(source)}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const runs = Array.isArray(summary.browserMetrics) ? summary.browserMetrics : [];
  if (runs.length === 0) {
    console.error('Baseline not saved: the current summary contains no browser metrics.');
    process.exitCode = 1;
    return;
  }
  if (summary.status === 'no-data') {
    console.error('Baseline not saved: the current summary status is "no-data".');
    process.exitCode = 1;
    return;
  }

  const target = config.baseline.file;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log(`Baseline saved to ${rel(target)} (status=${summary.status}, runId=${summary.runId || 'n/a'}).`);
  console.log('Environment is recorded in the baseline so incompatible comparisons are blocked later.');
}

if (require.main === module) {
  main();
}

module.exports = { main };
