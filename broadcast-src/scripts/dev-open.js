#!/usr/bin/env node
/**
 * Development launcher — opens the operator dashboard without an administrator
 * sign-in. It only sets DEV_BYPASS_LOGIN before booting the regular server, so
 * every other behaviour (broadcast state, sockets, storage) stays identical.
 *
 * Usage: npm run dev:open
 * Never use this mode on a public / production broadcast server.
 */
process.env.DEV_BYPASS_LOGIN = process.env.DEV_BYPASS_LOGIN || 'true';
if (!process.env.BIND_HOST && !process.env.NODE_ENV) process.env.BIND_HOST = '0.0.0.0';
console.log('BGMI Broadcast: development login bypass is ENABLED — /operator opens without sign-in.');
require('../server.js');
