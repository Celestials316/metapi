type PulledEventBatch<TEvent> = {
  events: TEvent[];
  rest: string;
};

type ProxyStreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
};

type ProxyStreamLifecycleInput<TEvent> = {
  reader: ProxyStreamReader | null | undefined;
  response: { end(): void };
  pullEvents(buffer: string): PulledEventBatch<TEvent>;
  handleEvent(event: TEvent): Promise<boolean | void> | boolean | void;
  onEof?: () => Promise<void> | void;
  idleTimeoutMs?: number;
  onIdleTimeout?: () => Promise<boolean | void> | boolean | void;
  onChunkActivity?: () => Promise<void> | void;
  onFinalize?: (input: { reason: 'eof' | 'idle_timeout' | 'stopped' }) => Promise<void> | void;
};

function clearTimer(timer: ReturnType<typeof setTimeout> | null) {
  if (!timer) return;
  clearTimeout(timer);
}

export function createProxyStreamLifecycle<TEvent>(input: ProxyStreamLifecycleInput<TEvent>) {
  const flushBuffer = async (buffer: string): Promise<{ rest: string; stop: boolean }> => {
    const pulled = input.pullEvents(buffer);
    for (const event of pulled.events) {
      if (await input.handleEvent(event)) {
        return {
          rest: pulled.rest,
          stop: true,
        };
      }
    }

    return {
      rest: pulled.rest,
      stop: false,
    };
  };

  return {
    async run(): Promise<void> {
      const reader = input.reader;
      if (!reader) {
        try {
          await input.onEof?.();
        } finally {
          input.response.end();
        }
        return;
      }

      const decoder = new TextDecoder();
      let sseBuffer = '';
      let shouldStop = false;
      const idleTimeoutMs = Math.max(0, Math.trunc(input.idleTimeoutMs ?? 0));
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let idleTimedOut = false;

      const resetIdleTimer = () => {
        clearTimer(idleTimer);
        if (idleTimeoutMs <= 0) return;
        idleTimer = setTimeout(() => {
          idleTimedOut = true;
        }, idleTimeoutMs);
      };

      try {
        while (true) {
          resetIdleTimer();
          const { done, value } = await reader.read();
          clearTimer(idleTimer);
          if (idleTimedOut) {
            shouldStop = !!await input.onIdleTimeout?.();
            await input.onFinalize?.({ reason: 'idle_timeout' });
            await reader.cancel(new Error('stream idle timeout')).catch(() => {});
            break;
          }
          if (done) break;
          if (!value) continue;

          await input.onChunkActivity?.();
          sseBuffer += decoder.decode(value, { stream: true });
          const flushed = await flushBuffer(sseBuffer);
          sseBuffer = flushed.rest;
          if (!flushed.stop) continue;

          shouldStop = true;
          await reader.cancel().catch(() => {});
          break;
        }

        if (!shouldStop) {
          sseBuffer += decoder.decode();
          if (sseBuffer.trim().length > 0) {
            const flushed = await flushBuffer(`${sseBuffer}\n\n`);
            sseBuffer = flushed.rest;
            shouldStop = flushed.stop;
          }
        }

        if (!shouldStop) {
          await input.onEof?.();
          await input.onFinalize?.({ reason: 'eof' });
        } else {
          await input.onFinalize?.({ reason: 'stopped' });
        }
      } finally {
        clearTimer(idleTimer);
        reader.releaseLock();
        input.response.end();
      }
    },
  };
}
