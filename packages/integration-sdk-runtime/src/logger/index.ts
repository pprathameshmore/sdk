import Logger from 'bunyan';
import { v4 as uuid } from 'uuid';

import {
  IntegrationError,
  UNEXPECTED_ERROR_CODE,
  UNEXPECTED_ERROR_REASON,
  PROVIDER_AUTH_ERROR_DESCRIPTION,
  IntegrationInstance,
  IntegrationInstanceConfigFieldMap,
  StepMetadata,
  ExecutionContext,
  StepExecutionContext,
  InvocationConfig,
  IntegrationExecutionContext,
  IntegrationStepExecutionContext,
  IntegrationInvocationConfig,
  IntegrationProviderAuthorizationError,
  IntegrationProviderAuthenticationError,
  IntegrationLogger,
  IntegrationLoggerFunctions,
  SynchronizationJob,
  Metric,
} from '@jupiterone/integration-sdk-core';

import { IntegrationEvent } from '../event';

// eslint-disable-next-line
const bunyanFormat = require('bunyan-format');

type OnPublishEventListener = (event: IntegrationEvent) => void;
type OnPublishMetricListener = (metric: Metric) => void;

interface CreateLoggerInput<
  TExecutionContext extends ExecutionContext,
  TStepExecutionContext extends StepExecutionContext
> {
  name: string;
  invocationConfig?: InvocationConfig<TExecutionContext, TStepExecutionContext>;
  pretty?: boolean;
  serializers?: Logger.Serializers;
  onPublishEvent?: OnPublishEventListener;
  onPublishMetric?: OnPublishMetricListener;
}

interface CreateIntegrationLoggerInput
  extends CreateLoggerInput<
    IntegrationExecutionContext,
    IntegrationStepExecutionContext
  > {
  invocationConfig?: IntegrationInvocationConfig;
}

export function createLogger<
  TExecutionContext extends ExecutionContext,
  TStepExecutionContext extends StepExecutionContext
>({
  name,
  pretty,
  serializers,
  onPublishEvent,
  onPublishMetric,
}: CreateLoggerInput<
  TExecutionContext,
  TStepExecutionContext
>): IntegrationLogger {
  const loggerConfig: Logger.LoggerOptions = {
    name,
    level: (process.env.LOG_LEVEL || 'info') as Logger.LogLevel,
    serializers: {
      err: Logger.stdSerializers.err,
    },
  };

  if (pretty) {
    loggerConfig.streams = [{ stream: bunyanFormat({ outputMode: 'short' }) }];
  }

  const logger = Logger.createLogger(loggerConfig);

  if (serializers) {
    logger.addSerializers(serializers);
  }

  const errorSet = new Set<Error>();

  const verboseTraceLogger = instrumentVerboseTrace(logger);

  return instrumentEventLogging(
    instrumentErrorTracking(verboseTraceLogger, errorSet),
    {
      onPublishEvent,
      onPublishMetric,
      errorSet,
    },
  );
}

/**
 * Create a logger for the integration that will include invocation details and
 * serializers common to all integrations.
 */
export function createIntegrationLogger({
  invocationConfig,
  ...loggerConfig
}: CreateIntegrationLoggerInput): IntegrationLogger {
  const serializeInstanceConfig = createInstanceConfigSerializer(
    invocationConfig?.instanceConfigFields,
  );

  return createLogger({
    ...loggerConfig,
    serializers: {
      integrationInstanceConfig: serializeInstanceConfig,
      // since config is serializable from
      instance: (instance: IntegrationInstance) => ({
        ...instance,
        config: instance.config
          ? serializeInstanceConfig(instance.config)
          : undefined,
      }),
      ...loggerConfig.serializers,
    },
  });
}

function createInstanceConfigSerializer(
  fields?: IntegrationInstanceConfigFieldMap,
) {
  return (config: any) => {
    if (!config) {
      return config;
    } else {
      const serialized: any = {};
      for (const k of Object.keys(config)) {
        const field = fields && fields[k];
        if (field) {
          serialized[k] = field.mask
            ? `****${config[k].substr(-4)}`
            : config[k];
        } else {
          serialized[k] = '***';
        }
      }
      return serialized;
    }
  };
}

function instrumentVerboseTrace(logger: Logger): Logger {
  const trace = logger.trace;
  const child = logger.child;

  Object.assign(logger, {
    trace: (...params: any[]) => {
      if (params.length === 0) {
        return trace.apply(logger);
      }

      let additionalFields: Record<string, any> = {};
      let remainingArgs: any[] = params;
      if (params[0] instanceof Error) {
        additionalFields = { err: params[0] };
        remainingArgs = params.slice(1);
      } else if (typeof params[0] === 'object') {
        additionalFields = params[0];
        remainingArgs = params.slice(1);
      }

      trace.apply(logger, [
        { verbose: true, ...additionalFields },
        ...remainingArgs,
      ]);
    },

    child: (options: object = {}, simple?: boolean) => {
      const c = child.apply(logger, [options, simple]);
      return instrumentVerboseTrace(c);
    },
  });

  return logger;
}

function instrumentErrorTracking(logger: Logger, errorSet: Set<Error>): Logger {
  const error = logger.error;
  const child = logger.child;

  Object.assign(logger, {
    error: (...params: any[]) => {
      if (params.length === 0) {
        return error.apply(logger);
      }

      if (params[0] instanceof Error) {
        errorSet.add(params[0]);
      } else if (params[0]?.err instanceof Error) {
        errorSet.add(params[0].err);
      }

      error.apply(logger, [...params]);
    },

    child: (options: object = {}, simple?: boolean) => {
      const c = child.apply(logger, [options, simple]);
      return instrumentErrorTracking(c, errorSet);
    },
  });

  return logger;
}

interface LogContext {
  errorSet: Set<Error>;
  onPublishEvent?: OnPublishEventListener;
  onPublishMetric?: OnPublishMetricListener;
}

function instrumentEventLogging(
  logger: Logger,
  context: LogContext,
): IntegrationLogger {
  const { onPublishEvent, onPublishMetric, errorSet } = context;
  const child = logger.child;

  const publishEvent = (name: string, description: string) => {
    if (process.env.JUPITERONE_DISABLE_EVENT_LOGGING === 'true') {
      return;
    }

    onPublishEvent?.({ name, description });
  };

  const createChildLogger = (options: object = {}, simple?: boolean) => {
    const childLogger = child.apply(logger, [options, simple]);
    return instrumentEventLogging(childLogger, context);
  };

  const integrationLoggerFunctions: IntegrationLoggerFunctions = {
    isHandledError: (err: Error) => errorSet.has(err),

    stepStart: (step: StepMetadata) => {
      const name = 'step_start';
      const description = `Starting step "${step.name}"...`;
      logger.info({ step: step.id }, description);

      publishEvent(name, description);
    },
    stepSuccess: (step: StepMetadata) => {
      const name = 'step_end';
      const description = `Completed step "${step.name}".`;
      logger.info({ step: step.id }, description);

      publishEvent(name, description);
    },
    stepFailure: (step: StepMetadata, err: Error) => {
      const name = 'step_failure';
      const { errorId, description } = createErrorEventDescription(
        err,
        `Step "${step.name}" failed to complete due to error.`,
      );

      logger.error({ errorId, err, step: step.id }, description);

      publishEvent(name, description);
    },
    synchronizationUploadStart: (job: SynchronizationJob) => {
      const name = 'sync_upload_start';
      const description = 'Uploading collected data for synchronization...';
      logger.info(
        {
          synchronizationJobId: job.id,
        },
        description,
      );

      publishEvent(name, description);
    },
    synchronizationUploadEnd: (job: SynchronizationJob) => {
      const name = 'sync_upload_end';
      const description = 'Upload complete.';
      logger.info(
        {
          synchronizationJobId: job.id,
        },
        description,
      );

      publishEvent(name, description);
    },
    validationFailure: (err: Error) => {
      const name = 'validation_failure';
      const { errorId, description } = createErrorEventDescription(
        err,
        `Error occurred while validating integration configuration.`,
      );

      logger.error({ errorId, err }, description);
      publishEvent(name, description);
    },

    publishMetric: (metric: Metric) => {
      console.log('publish listener', onPublishMetric);
      onPublishMetric?.(metric);
    },

    publishEvent(options) {
      return publishEvent(options.name, options.description);
    },

    publishErrorEvent(options) {
      const {
        name,
        message,
        err,

        // `logData` is only logged (it is used to log data that should
        // not be shown to customer but might be helpful for troubleshooting)
        logData,

        // `eventData` is added to error description but not logged
        eventData,
      } = options;
      const { errorId, description } = createErrorEventDescription(
        err,
        message,
        eventData,
      );

      logger.error({ ...logData, errorId, err }, description);
      publishEvent(name, description);
    },
  };

  return Object.assign(logger, {
    ...integrationLoggerFunctions,
    child: createChildLogger,
  });
}

type NameValuePair = [string, any];

export function createErrorEventDescription(
  err: Error | IntegrationError,
  message: string,

  /**
   * Optional data that will be added as name/value pairs to the
   * event description.
   */
  eventData?: object,
) {
  const errorId = uuid();

  let errorCode: string;
  let errorReason: string;

  if (err instanceof IntegrationError) {
    errorCode = err.code;
    errorReason = err.message;
  } else {
    errorCode = UNEXPECTED_ERROR_CODE;
    errorReason = UNEXPECTED_ERROR_REASON;
  }

  if (isProviderAuthError(err)) {
    // add additional instructions to the displayed message
    // if we know that this is an auth error
    message += PROVIDER_AUTH_ERROR_DESCRIPTION;
  }

  const nameValuePairs: NameValuePair[] = [
    ['errorCode', errorCode],
    ['errorId', errorId],
    ['reason', errorReason],
  ];

  if (eventData) {
    for (const key of Object.keys(eventData)) {
      nameValuePairs.push([key, eventData[key]]);
    }
  }

  const errorDetails = nameValuePairs
    .map((nameValuePair) => {
      return `${nameValuePair[0]}=${JSON.stringify(nameValuePair[1])}`;
    })
    .join(', ');

  return {
    errorId,
    description: `${message} (${errorDetails})`,
  };
}

type ProviderAuthError =
  | IntegrationProviderAuthorizationError
  | IntegrationProviderAuthenticationError;

export function isProviderAuthError(err: Error): err is ProviderAuthError {
  return (
    err instanceof IntegrationProviderAuthorizationError ||
    err instanceof IntegrationProviderAuthenticationError
  );
}
