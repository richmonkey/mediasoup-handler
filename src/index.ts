import debug from 'debug';
import { Device, detectDevice } from './Device';
import { Transport, SendTransport, RecvTransport } from './types';
import * as types from './types';

/**
 * Expose all types.
 */
export { types };

/**
 * Expose mediasoup-client version.
 */
export const version = '__MEDIASOUP_CLIENT_VERSION__';

/**
 * Expose Device class and detectDevice() helper.
 */
export { Device, detectDevice };

export {Transport, SendTransport, RecvTransport};

/**
 * Expose parseScalabilityMode() function.
 */
export { parse as parseScalabilityMode } from './scalabilityModes';

/**
 * Expose the debug module.
 */
export { debug };
