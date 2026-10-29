'use strict';

// An error with an HTTP status and a contract error code ({ error, message }).
class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

const MESSAGES = {
  unauthorized: 'Sign in again.',
  no_minutes: 'No copilot time left.',
  lease_active: 'Another Vkin session is active. End it there, or wait a minute and try again.',
  lease_inactive: 'This session is not active. Start a session first.',
  not_found: 'Not found.',
  model_not_allowed: 'That model is not available on Vkin.',
  capacity: 'Vkin trial capacity is used up for now. Please try again later.',
  price_unknown: 'Pricing for this model is unknown, so it is disabled.',
  bad_request: 'The request is not valid.',
  provider_unavailable: 'This model provider is not configured on the server.',
  upstream_error: 'The model provider returned an error.',
  auth_unavailable: 'Sign-in could not be checked right now. Please try again.',
  internal: 'Something went wrong on the server.',
};

function sendError(res, status, code, message, extra) {
  if (res.headersSent) return;
  res.status(status).json({ error: code, message: message || MESSAGES[code] || code, ...(extra || {}) });
}

module.exports = { ApiError, MESSAGES, sendError };
