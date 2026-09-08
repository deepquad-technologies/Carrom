'use client';

import { useEffect } from 'react';
import { reportError, startTelemetry } from '@/lib/telemetry';

/**
 * Mounts the performance sampler and catches anything that escapes React.
 *
 * Rendering nothing is the point: this exists so the fleet's frame rate and
 * crash rate are measurable without any player noticing it is there.
 */
export default function Telemetry() {
  useEffect(() => {
    const stop = startTelemetry();

    const onError = (event: ErrorEvent) => {
      reportError('error', event.message, event.error?.stack, {
        source: event.filename,
        line: event.lineno,
      });
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      reportError(
        'error',
        reason instanceof Error ? reason.message : String(reason),
        reason instanceof Error ? reason.stack : undefined,
        { unhandledRejection: true },
      );
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    return () => {
      stop();
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return null;
}
