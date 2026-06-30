const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const { ensureDir, fromRoot } = require("../../qa-utils/src");

function check(status, name, message, extra = {}) {
  return { status, name, message, ...extra };
}

function readPng(filePath) {
  return PNG.sync.read(fs.readFileSync(filePath));
}

function comparePngs(baselinePath, currentPath, diffPath, threshold = 0.01) {
  const baseline = readPng(baselinePath);
  const current = readPng(currentPath);
  if (baseline.width !== current.width || baseline.height !== current.height) {
    return { mismatchRatio: 1, reason: `Dimension mismatch: baseline ${baseline.width}x${baseline.height}, current ${current.width}x${current.height}.` };
  }

  const diff = new PNG({ width: baseline.width, height: baseline.height });
  let mismatchedPixels = 0;
  const totalPixels = baseline.width * baseline.height;

  for (let index = 0; index < baseline.data.length; index += 4) {
    const delta =
      Math.abs(baseline.data[index] - current.data[index]) +
      Math.abs(baseline.data[index + 1] - current.data[index + 1]) +
      Math.abs(baseline.data[index + 2] - current.data[index + 2]) +
      Math.abs(baseline.data[index + 3] - current.data[index + 3]);

    if (delta / 1020 > threshold) {
      mismatchedPixels += 1;
      diff.data[index] = 220;
      diff.data[index + 1] = 38;
      diff.data[index + 2] = 38;
      diff.data[index + 3] = 255;
    } else {
      diff.data[index] = current.data[index];
      diff.data[index + 1] = current.data[index + 1];
      diff.data[index + 2] = current.data[index + 2];
      diff.data[index + 3] = 80;
    }
  }

  ensureDir(path.dirname(diffPath));
  fs.writeFileSync(diffPath, PNG.sync.write(diff));
  return { mismatchRatio: mismatchedPixels / totalPixels, reason: `${mismatchedPixels} of ${totalPixels} pixels changed.` };
}

function runVisualRegression(config, screenshotPaths = [], options = {}) {
  if (options.dryRun) {
    return { checks: [check("passed", "visual regression dry run", "Would compare screenshots against PNG baselines.")] };
  }

  if (!config.visualRegression?.enabled) {
    return { checks: [check("skipped", "visual regression", "Visual regression is not enabled for this product.")] };
  }

  if (screenshotPaths.length === 0) {
    return { checks: [check("skipped", "visual regression", "No screenshots were captured for comparison.")] };
  }

  const checks = [];
  const threshold = config.visualRegression.threshold ?? 0.01;
  const maxMismatchRatio = config.visualRegression.maxMismatchRatio ?? 0.0025;

  for (const currentPath of screenshotPaths) {
    const fileName = path.basename(currentPath);
    const baselinePath = fromRoot("screenshots", "baseline", config.key, fileName);
    const diffPath = fromRoot("screenshots", "diff", config.key, fileName);

    if (!fs.existsSync(baselinePath)) {
      if (options.updateBaselines) {
        ensureDir(path.dirname(baselinePath));
        fs.copyFileSync(currentPath, baselinePath);
        checks.push(check("passed", `visual baseline ${fileName}`, "Created missing baseline.", { artifact: baselinePath }));
      } else {
        checks.push(check("warning", `visual baseline ${fileName}`, "Missing baseline. Re-run with --update-baselines after reviewing the screenshot."));
      }
      continue;
    }

    const comparison = comparePngs(baselinePath, currentPath, diffPath, threshold);
    checks.push(
      comparison.mismatchRatio <= maxMismatchRatio
        ? check("passed", `visual ${fileName}`, `${comparison.reason} Mismatch ratio ${comparison.mismatchRatio.toFixed(4)}.`, { artifact: diffPath })
        : check("failed", `visual ${fileName}`, `${comparison.reason} Mismatch ratio ${comparison.mismatchRatio.toFixed(4)} exceeds ${maxMismatchRatio}.`, { artifact: diffPath })
    );
  }

  return { checks };
}

module.exports = {
  comparePngs,
  runVisualRegression,
};

