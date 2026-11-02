const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const winston = require('winston');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const LOG_TIMEZONE = String(process.env.LOG_TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai';

function createLogTimeFormatter(timeZone) {
  const options = {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  };
  try {
    return new Intl.DateTimeFormat('en-CA', options);
  } catch (_err) {
    return new Intl.DateTimeFormat('en-CA', { ...options, timeZone: 'Asia/Shanghai' });
  }
}

const logTimeFormatter = createLogTimeFormatter(LOG_TIMEZONE);

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getLogTimeParts(date) {
  return Object.fromEntries(
    logTimeFormatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
}

function formatLocalDate(date) {
  const parts = getLogTimeParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatLogTimestamp(date) {
  const parts = getLogTimeParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function getRetentionCutoffDate(retentionDays) {
  const cutoff = new Date(Date.now() - (retentionDays - 1) * MS_PER_DAY);
  return formatLocalDate(cutoff);
}

function normalizeDate(year, month, day) {
  const normalized = `${year}-${month}-${day}`;
  const date = new Date(`${normalized}T00:00:00`);
  if (
    date.getFullYear() !== Number(year)
    || date.getMonth() + 1 !== Number(month)
    || date.getDate() !== Number(day)
  ) {
    return '';
  }
  return normalized;
}

function getLogDateFromName(fileName) {
  const compactMatch = /(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)/.exec(fileName);
  if (!compactMatch) return '';
  return normalizeDate(compactMatch[1], compactMatch[2], compactMatch[3]);
}

function isLogFile(fileName) {
  return /\.(log|out|err)$/i.test(fileName) || /\.(out|err)\.log$/i.test(fileName);
}

function isLegacyWinstonLog(fileName) {
  return fileName === 'combined.log' || fileName === 'error.log';
}

function compactLegacyWinstonLog(filePath, cutoffDate) {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return;
  }

  const kept = [];
  let keepCurrentEntry = false;
  for (const line of content.split(/\r?\n/)) {
    const timestamp = /^\[(\d{4}-\d{2}-\d{2})/.exec(line);
    if (timestamp) {
      keepCurrentEntry = timestamp[1] >= cutoffDate;
    }
    if (keepCurrentEntry) kept.push(line);
  }

  try {
    if (kept.length === 0 || (kept.length === 1 && kept[0] === '')) {
      fs.unlinkSync(filePath);
      return;
    }
    fs.writeFileSync(filePath, kept.join('\n'));
  } catch (_err) {
    // Best-effort cleanup only; logging should never fail startup.
  }
}

function pruneOldLogs(logDir, retentionDays) {
  const cutoffMs = Date.now() - retentionDays * MS_PER_DAY;
  const cutoffDate = getRetentionCutoffDate(retentionDays);

  function visit(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }

    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.isFile() || !isLogFile(entry.name)) continue;

      try {
        const datedLogDate = getLogDateFromName(entry.name);
        const stat = fs.statSync(filePath);
        if (isLegacyWinstonLog(entry.name)) {
          compactLegacyWinstonLog(filePath, cutoffDate);
        } else if ((datedLogDate && datedLogDate < cutoffDate) || (!datedLogDate && stat.mtimeMs < cutoffMs)) {
          fs.unlinkSync(filePath);
        }
      } catch (_err) {
        // Best-effort cleanup only; logging should never fail startup.
      }
    }
  }

  visit(logDir);
}

class DailyFileStream extends Writable {
  constructor(logDir, prefix) {
    super();
    this.logDir = logDir;
    this.prefix = prefix;
    this.currentDate = '';
    this.currentStream = null;
  }

  _ensureStream() {
    const today = formatLocalDate(new Date());
    if (this.currentStream && this.currentDate === today) return;

    if (this.currentStream) {
      this.currentStream.end();
    }

    this.currentDate = today;
    this.currentStream = fs.createWriteStream(path.join(this.logDir, `${this.prefix}-${today}.log`), {
      flags: 'a',
    });
    this.currentStream.on('error', (err) => {
      process.stderr.write(`[logger] write ${this.prefix} log failed: ${err.message}\n`);
    });
  }

  _write(chunk, encoding, callback) {
    try {
      this._ensureStream();
      this.currentStream.write(chunk, encoding, callback);
    } catch (err) {
      callback(err);
    }
  }

  _final(callback) {
    if (!this.currentStream) {
      callback();
      return;
    }
    this.currentStream.end(callback);
  }
}

function setupLogRetention(logDir, retentionDays) {
  pruneOldLogs(logDir, retentionDays);
  const timer = setInterval(() => pruneOldLogs(logDir, retentionDays), MS_PER_DAY);
  timer.unref();
}

function buildTransports() {
  const transports = [new winston.transports.Console()];
  const logDir =
    process.env.LOG_DIR || (process.env.NODE_ENV === 'production' ? path.join(process.cwd(), 'logs') : '');
  const retentionDays = parsePositiveInt(process.env.LOG_RETENTION_DAYS, 7);

  if (!logDir) {
    return transports;
  }

  fs.mkdirSync(logDir, { recursive: true });
  setupLogRetention(logDir, retentionDays);
  transports.push(
    new winston.transports.Stream({
      stream: new DailyFileStream(logDir, 'error'),
      level: 'error',
    }),
    new winston.transports.Stream({
      stream: new DailyFileStream(logDir, 'combined'),
    })
  );

  return transports;
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: () => formatLogTimestamp(new Date()) }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: buildTransports(),
});

module.exports = logger;
