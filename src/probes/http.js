const http = require('http');
const https = require('https');
const { compact, each, isArray, isNaN, last, pick } = require('lodash');
const moment = require('moment');
const url = require('url');

const { buildMetric, increase, parseBooleanQueryParam, parseHttpParamsQueryParam, toArray } = require('../utils');

exports.probeHttp = function(target, ctx, state = {}) {
  return new Promise(resolve => {

    const followRedirects = parseBooleanQueryParam(ctx.query.followRedirects, true);

    // TODO: support query parameters
    const reqOptions = {
      method: ctx.query.method || 'GET',
      ...url.parse(target),
      agent: false,
      headers: parseHttpParamsQueryParam(ctx.query.header),
      rejectUnauthorized: !parseBooleanQueryParam(ctx.query.allowUnauthorized)
    };

    const times = {
      start: new Date().getTime()
    };

    state.requests = state.requests || [];
    state.requests.push(reqOptions);

    const req = (target.match(/^https:/i) ? https : http).request(reqOptions, res => {

      let body = '';

      res.on('readable', () => {
        if (state.firstByte === undefined) {
          times.firstByteAt = new Date().getTime();
          increase(state, 'firstByte', times.firstByteAt - (times.tlsHandshakeAt || times.tcpConnectionAt));
        }

        res.read();
      });

      res.on('data', chunk => {
        body += chunk;
        res.read();
      });

      res.on('end', () => {
        if (times.firstByteAt !== undefined) {
          increase(state, 'contentTransfer', new Date().getTime() - times.firstByteAt);
        }

        if (followRedirects && res.statusCode >= 301 && res.statusCode <= 302) {
          increase(state, 'redirects', 1);
          resolve(exports.probeHttp(res.headers.location, ctx, state));
        } else {
          resolve(getHttpMetrics(ctx, req, Object.assign(res, { body }), state));
        }
      });
    });

    req.on('socket', socket => {
      socket.on('lookup', () => {
        times.dnsLookupAt = new Date().getTime();
        increase(state, 'dnsLookup', times.dnsLookupAt - times.start);
      });

      socket.on('connect', () => {
        times.tcpConnectionAt = new Date().getTime();
        increase(state, 'tcpConnection', times.tcpConnectionAt - (times.dnsLookupAt || times.start));
      });

      socket.on('secureConnect', () => {
        times.tlsHandshakeAt = new Date().getTime();
        increase(state, 'tlsHandshake', times.tlsHandshakeAt - times.tcpConnectionAt);
      });
    });

    req.on('error', () => {
      resolve(getHttpMetrics(ctx, req, undefined, state));
    });

    req.end();
  });
};

function getHttpMetrics(ctx, req, res, state) {

  const failures = [];
  const metrics = [];

  if (res) {
    validateHttpRedirects(ctx, state, failures);
    validateHttpRedirectTarget(ctx, state, failures);
    validateHttpResponseBody(ctx, res, failures);
    validateHttpSecurity(ctx, state, failures);
    validateHttpStatusCode(ctx, res, failures);
    validateHttpVersion(ctx, res, failures);
  }

  const success = !!res && !failures.length;

  metrics.push(buildMetric(
    'httpCertificateExpiry',
    'datetime',
    getHttpCertificateExpiry(req),
    'Expiration date of the SSL certificate'
  ));

  metrics.push(buildMetric(
    'httpContentLength',
    'bytes',
    res && res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null,
    'Length of the HTTP response entity in bytes',
  ));

  each(pick(state, 'contentTransfer', 'dnsLookup', 'firstByte', 'tcpConnection', 'tlsHandshake'), (value, phase) => {
    metrics.push(buildMetric(
      'httpDuration',
      'seconds',
      value / 1000,
      'Duration of the HTTP request(s) by phase, summed over all redirects, in seconds',
      { phase }
    ));
  });

  metrics.push(buildMetric(
    'httpRedirects',
    'quantity',
    state.redirects || 0,
    'Number of times HTTP 301 or 302 redirects were followed'
  ));

  metrics.push(buildMetric(
    'httpSecure',
    'boolean',
    // FIXME: check whether SSL/TLS is used on final redirect (currently works at any redirect)
    state.tlsHandshake !== undefined,
    'Indicates whether SSL/TLS was used for the final request'
  ));

  metrics.push(buildMetric(
    'httpStatusCode',
    'number',
    res ? res.statusCode : null,
    'HTTP status code of the final response'
  ));

  metrics.push(buildMetric(
    'httpVersion',
    'number',
    res ? parseFloat(res.httpVersion) : null,
    'HTTP version of the response'
  ));

  return { failures, metrics, success };
}

function validateHttpRedirects(ctx, state, failures) {

  let expectedRedirects;
  if (ctx.query.expectHttpRedirects !== undefined) {
    expectedRedirects = ctx.query.expectHttpRedirects;
  } else if (ctx.query.expectHttpRedirectTo) {
    expectedRedirects = 'yes';
  }

  const expectedRedirectCount = Number(expectedRedirects);
  if (!isNaN(expectedRedirectCount) && state.redirects !== expectedRedirectCount) {
    return failures.push({
      actual: state.redirects,
      cause: 'invalidHttpRedirectCount',
      description: `Expected the HTTP request to be redirected exactly ${expectedRedirectCount} time${expectedRedirectCount !== 1 ? 's' : ''}`,
      expected: expectedRedirectCount
    });
  }

  const shouldRedirect = parseBooleanQueryParam(expectedRedirects, null);
  if (shouldRedirect === true && !state.redirects) {
    return failures.push({
      cause: 'missingHttpRedirect',
      description: 'Expected the server to send an HTTP redirection'
    });
  } else if (shouldRedirect === false && state.redirects) {
    return failures.push({
      actual: state.redirects,
      cause: 'unexpectedHttpRedirect',
      description: 'Did not expect the server to send an HTTP redirection',
      expected: 0
    });
  }
}

function validateHttpRedirectTarget(ctx, state, failures) {

  const expectedRedirect = ctx.query.expectHttpRedirectTo !== undefined ? url.parse(ctx.query.expectHttpRedirectTo) : undefined;
  if (!expectedRedirect) {
    return;
  }

  const lastRequest = last(state.requests);
  if (expectedRedirect.protocol !== lastRequest.protocol || expectedRedirect.host !== lastRequest.host || expectedRedirect.pathname !== lastRequest.pathname) {
    failures.push({
      actual: url.format(lastRequest),
      cause: 'invalidHttpRedirectLocation',
      description: `Expected the request to be redirected to ${ctx.query.expectHttpRedirectTo}`,
      expected: url.format(expectedRedirect)
    });
  }
}

function validateHttpResponseBody(ctx, res, failures) {

  const body = String(res.body);

  for (const expectedMatch of toArray(ctx.query.expectHttpResponseBodyMatch)) {
    if (!body.match(new RegExp(expectedMatch))) {
      failures.push({
        cause: 'httpResponseBodyMismatch',
        description: `Expected the HTTP response body to match the following regular expression: ${expectedMatch}`,
        expected: expectedMatch
      });
    }
  }

  for (const expectedMismatch of toArray(ctx.query.expectHttpResponseBodyMismatch)) {
    const match = body.match(new RegExp(expectedMismatch));
    if (match) {
      failures.push({
        actual: match[0],
        cause: 'unexpectedHttpResponseBodyMatch',
        description: `Did not expect the HTTP response body to match the following regular expression: ${expectedMismatch}`,
        expected: expectedMismatch
      });
    }
  }
}

function validateHttpSecurity(ctx, state, failures) {
  const expectSecure = parseBooleanQueryParam(last(toArray(ctx.query.expectHttpSecure)), null);
  if (expectSecure === true && state.tlsHandshake === undefined) {
    failures.push({
      cause: 'insecureHttp',
      description: 'Expected the server to use SSL/TLS for the request (or final redirect)'
    });
  } else if (expectSecure === false && state.tlsHandshake !== undefined) {
    failures.push({
      cause: 'unexpectedlySecureHttp',
      description: 'Did not expect the server to use SSL/TLS for the request (or final redirect)'
    });
  }
}

function validateHttpStatusCode(ctx, res, failures) {

  const actual = res.statusCode;
  const expected = isArray(ctx.query.expectHttpStatusCode) ? ctx.query.expectHttpStatusCode : compact([ ctx.query.expectHttpStatusCode ]);
  if (!expected.length) {
    expected.push('2xx', '3xx');
  }

  for (const code of expected) {
    if (typeof code !== 'string') {
      continue;
    }

    const rangeMatch = code.match(/^([1-5])xx$/i);
    if (rangeMatch) {
      const rangeStart = parseInt(rangeMatch[1], 10) * 100;
      if (actual >= rangeStart && actual <= rangeStart + 99) {
        return;
      }
    }

    const asNumber = Number(code);
    if (!isNaN(asNumber) && asNumber === actual) {
      return;
    }
  }

  failures.push({
    actual: res.statusCode,
    cause: 'invalidHttpStatusCode',
    description: `Expected HTTP status code to match one of the following: ${expected.join(', ')}`,
    expected: toArray(ctx.query.expectHttpStatusCode)
  });
}

function validateHttpVersion(ctx, res, failures) {
  const actual = res.httpVersion;
  const expected = ctx.query.expectHttpVersion;
  if (expected && String(actual) !== String(expected)) {
    failures.push({
      actual,
      cause: 'invalidHttpVersion',
      description: `Expected HTTP version to be "${expected}"`,
      expected: parseFloat(expected)
    });
  }
}

function getHttpCertificateExpiry(req) {
  if (!req.connection || typeof req.connection.getPeerCertificate !== 'function') {
    return null;
  }

  const certificate = req.connection.getPeerCertificate();
  return certificate ? moment.utc(new Date(certificate.valid_to)).format() : null;
}
