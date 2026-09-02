import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';

// Single shared instances (module scope = reused across warm invocations)
export const logger = new Logger();
export const tracer = new Tracer();
export const metrics = new Metrics();
