import winstonLogger from './winstonLogger';
import { Logger } from 'winston';

export interface ExtendedLogger extends Logger {
  fetcherError: (message: string, meta?: any) => void;
  networkInfo: (message: string, meta?: any) => void;
  networkError: (message: string, meta?: any) => void;
}

// Export the Winston logger as the default logger with extended types
export const logger = winstonLogger as ExtendedLogger;

// For compatibility, export a createFetcherLogger that returns the same logger
export function createFetcherLogger(fetcherName: string) {
  // Optionally, you can add child loggers or labels here
  return winstonLogger as ExtendedLogger;
}
