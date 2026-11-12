/** Console logger: one line per event, with a timestamp and a level. `silent` is used by the tests. */
export function createLogger({ silent = false } = {}) {
  const write = (level, message, details) => {
    if (silent) return;
    const line = `${new Date().toISOString()} [${level}] ${message}`;
    const out = level === 'ERROR' ? console.error : console.log;
    details === undefined ? out(line) : out(line, details);
  };
  return {
    debug: (message, details) => write('DEBUG', message, details),
    info: (message, details) => write('INFO', message, details),
    warn: (message, details) => write('WARN', message, details),
    error: (message, details) => write('ERROR', message, details),
  };
}
