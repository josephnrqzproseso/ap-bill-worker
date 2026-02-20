function format(level, message, meta) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message
  };
  if (meta && Object.keys(meta).length) payload.meta = meta;
  return JSON.stringify(payload);
}

function createLogger(level = "info") {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const current = levels[level] ?? levels.info;

  function write(target, msgLevel, message, meta = {}) {
    if ((levels[msgLevel] ?? levels.info) > current) return;
    target(format(msgLevel, message, meta));
  }

  return {
    error(message, meta) {
      write(console.error, "error", message, meta);
    },
    warn(message, meta) {
      write(console.warn, "warn", message, meta);
    },
    info(message, meta) {
      write(console.log, "info", message, meta);
    },
    debug(message, meta) {
      write(console.log, "debug", message, meta);
    }
  };
}

module.exports = {
  createLogger
};
