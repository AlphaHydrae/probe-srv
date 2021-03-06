import { readFile } from 'fs-extra';
import { isPlainObject, merge, pick, reduce } from 'lodash';

import { validateLogLevelOption } from './logger';
import { validateHttpProbeOptions } from './probes/http';
import { HttpProbeOptions, S3ProbeOptions } from './probes/options';
import { validateS3ProbeOptions } from './probes/s3';
import { LoggerOptions, LogLevel, ProbeCommand } from './types';
import {
  compactResolved, firstResolved, loadConfig, parseHttpParams, Raw,
  validateBooleanOption, validateCommand, validateNumericOption, validateStringOption
} from './utils';

const defaultConfigFile = 'config.yml';

type ConfigValue<T> = T | Promise<T | undefined> | undefined;

export interface GeneralOptions {
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
}

export interface Config extends GeneralOptions, HttpProbeOptions, LoggerOptions, S3ProbeOptions {
  commands?: { [key: string]: ProbeCommand };
  config?: string;
  port?: number;
  presets?: string;
  pretty?: boolean;
}

export async function load(options: Partial<Config> = {}): Promise<Config> {

  const fromEnvironment = {
    // General options
    awsAccessKeyId: firstResolved(getEnv('PROBE_AWS_ACCESS_KEY_ID'), getEnv('AWS_ACCESS_KEY_ID')),
    awsSecretAccessKey: firstResolved(getEnv('PROBE_AWS_SECRET_ACCESS_KEY'), getEnv('AWS_SECRET_ACCESS_KEY')),
    config: getEnv('PROBE_CONFIG'),
    logLevel: getEnv('PROBE_LOG_LEVEL'),
    port: firstResolved(getEnv('PROBE_PORT'), getEnv('PORT')),
    presets: getEnv('PROBE_PRESETS'),
    pretty: getEnv('PROBE_PRETTY'),
    // HTTP probe parameters
    allowUnauthorized: getEnv('PROBE_ALLOW_UNAUTHORIZED'),
    followRedirects: getEnv('PROBE_FOLLOW_REDIRECTS'),
    headers: Promise.resolve(getEnv('PROBE_HEADER')).then(parseHttpParams),
    method: getEnv('PROBE_METHOD'),
    // HTTP probe expectations
    expectHttpRedirects: getEnv('PROBE_EXPECT_HTTP_REDIRECTS'),
    expectHttpRedirectTo: getEnv('PROBE_EXPECT_HTTP_REDIRECT_TO'),
    expectHttpResponseBodyMatch: compactResolved(getEnv('PROBE_HTTP_RESPONSE_BODY_MATCH')),
    expectHttpResponseBodyMismatch: compactResolved(getEnv('PROBE_HTTP_RESPONSE_BODY_MISMATCH')),
    expectHttpSecure: getEnv('PROBE_EXPECT_HTTP_SECURE'),
    expectHttpStatusCode: getEnv('PROBE_EXPECT_HTTP_STATUS_CODE'),
    expectHttpVersion: getEnv('PROBE_EXPECT_HTTP_VERSION'),
    // S3 probe parameters
    s3AccessKeyId: getEnv('PROBE_S3_ACCESS_KEY_ID'),
    s3SecretAccessKey: getEnv('PROBE_S3_SECRET_ACCESS_KEY'),
    s3ByPrefix: compactResolved(getEnv('PROBE_S3_BY_PREFIX')),
    s3ByPrefixOnly: getEnv('PROBE_S3_BY_PREFIX_ONLY'),
    s3Versions: getEnv('PROBE_S3_VERSIONS')
  };

  const fromFilePromise = loadConfigFile(
    options.config ?? await fromEnvironment.config ?? defaultConfigFile, !options.config && !fromEnvironment.config
  );

  const fromEnvironmentKeys = Object.keys(fromEnvironment);
  const fromEnvironmentValues = fromEnvironmentKeys.map(key => fromEnvironment[key]);

  const resolved = await Promise.all([ fromFilePromise, ...fromEnvironmentValues ]);
  const fromFile = resolved.shift();

  const resolvedFromEnvironment = fromEnvironmentKeys.reduce((memo, key, i) => ({ ...memo, [key]: resolved[i] }), {});

  const defaults = {
    logLevel: 'info' as LogLevel,
    port: 3000,
    presets: 'presets/**/*.@(json|yml)'
  };

  const config = merge(
    {},
    validateConfig(defaults),
    validateConfig(fromFile),
    validateConfig(resolvedFromEnvironment),
    validateConfig(options)
  );

  return validateConfig(config);
}

export { whitelistConfig as whitelist };

function getEnv(varName: string): ConfigValue<string> {
  if (process.env[varName] !== undefined) {
    return process.env[varName];
  }

  const fileVarName = `${varName}_FILE`;
  const file = process.env[fileVarName];
  if (file === undefined) {
    return;
  }

  return readFile(file, 'utf8').then(contents => contents.trim());
}

async function loadConfigFile(file: string, optional: boolean) {
  try {
    return await loadConfig(file);
  } catch (err) {
    if (err.code === 'ENOENT' && optional) {
      return {};
    } else if (err.code === 'ENOENT') {
      throw new Error(`Configuration file "${file}" does not exist`);
    } else {
      throw err;
    }
  }
}

function validateConfig(config: Raw<Config>): Config {
  return {
    awsAccessKeyId: validateStringOption(config, 'awsAccessKeyId'),
    awsSecretAccessKey: validateStringOption(config, 'awsSecretAccessKey'),
    // FIXME: validate commands
    commands: validateCommands(config.commands),
    config: validateStringOption(config, 'config'),
    port: validateNumericOption(config, 'port', true, 0, 65535),
    presets: validateStringOption(config, 'presets'),
    pretty: validateBooleanOption(config, 'pretty'),
    logLevel: validateLogLevelOption(config),
    ...validateHttpProbeOptions(config),
    ...validateS3ProbeOptions(config)
  };
}

function validateCommands(commands: any): { [key: string]: ProbeCommand } | undefined {
  if (commands === undefined) {
    return;
  } else if (!isPlainObject(commands)) {
    throw new Error(`The "commands" property of the configuration file must be a plain object; got ${typeof commands}`);
  }

  return reduce(commands, (memo, value, key) => ({ ...memo, [key]: validateCommand(value, key) }), {});
}

function whitelistConfig<T extends object = any>(config: T): Partial<Config> {
  return pick(
    config,
    // General options
    'awsAccessKeyId',
    'awsSecretAccessKey',
    'config',
    'logLevel',
    'port',
    'presets',
    'pretty',
    // Commands
    'commands',
    // HTTP probe parameters
    'allowUnauthorized',
    'followRedirects',
    'headers',
    'method',
    // HTTP probe expectations
    'expectHttpRedirects',
    'expectHttpRedirectTo',
    'expectHttpResponseBodyMatch',
    'expectHttpResponseBodyMismatch',
    'expectHttpSecure',
    'expectHttpStatusCode',
    'expectHttpVersion',
    // S3 probe parameters
    's3AccessKeyId',
    's3SecretAccessKey',
    's3ByPrefix',
    's3ByPrefixOnly',
    's3Versions'
  );
}
