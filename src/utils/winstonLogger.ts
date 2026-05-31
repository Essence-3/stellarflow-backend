import { createLogger, format, transports } from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logDir = path.resolve(__dirname, "../../logs");

// Custom filters to separate network and system logs
const networkFilter = format((info) => {
  return info.isNetwork ? info : false;
});

const systemFilter = format((info) => {
  return info.isNetwork ? false : info;
});

const baseFormat = format.combine(
  format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  format.errors({ stack: true }),
  format.splat(),
  format.json(),
);

const logger = createLogger({
  level: "info",
  transports: [
    new DailyRotateFile({
      filename: path.join(logDir, "system-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "100m",
      maxFiles: "10",
      zippedArchive: true,
      handleExceptions: true,
      handleRejections: true,
      format: format.combine(systemFilter(), baseFormat),
    }),
    new DailyRotateFile({
      filename: path.join(logDir, "stellar-network-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "100m",
      maxFiles: "10",
      zippedArchive: true,
      format: format.combine(networkFilter(), baseFormat),
    }),
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
      handleExceptions: true,
      handleRejections: true,
    }),
  ],
  exitOnError: false,
});

// Add custom methods for fetcher-specific logging
(logger as any).fetcherError = (message: string, meta?: any) => {
  logger.error(`[FETCHER_ERROR] ${message}`, meta);
};

// Add custom methods for network boundary logging
(logger as any).networkInfo = (message: string, meta?: any) => {
  logger.info(`[NETWORK] ${message}`, { ...meta, isNetwork: true });
};

(logger as any).networkError = (message: string, meta?: any) => {
  logger.error(`[NETWORK_ERROR] ${message}`, { ...meta, isNetwork: true });
};

export default logger;
