function nowIso() {
  return new Date().toISOString();
}

function durationMs(startTime, endTime = Date.now()) {
  return endTime - startTime;
}

function slugTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

module.exports = {
  nowIso,
  durationMs,
  slugTimestamp,
};

