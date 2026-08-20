import { ConfigService } from '@nestjs/config';
import { TelegramService, TelegramApiError } from './telegram.service';

const fetchMock = jest.fn();
(global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

const okResponse = () =>
  ({
    ok: true,
    status: 200,
    text: () => Promise.resolve('{"result":{"message_id":1}}'),
  } as unknown as Response);

const tooManyRequests = (retryAfter = 1) =>
  ({
    ok: false,
    status: 429,
    text: () => Promise.resolve(JSON.stringify({ parameters: { retry_after: retryAfter } })),
  } as unknown as Response);

function makeService() {
  const config = new ConfigService({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_BOT_USERNAME: 'tradeping_bot',
    APP_BASE_URL: 'https://tradeping.example',
    TELEGRAM_WEBHOOK_SECRET: 'secret',
  });
  return new TelegramService(config);
}

describe('TelegramService', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('serializes sends to the same chat at >= 1100ms intervals', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const svc = makeService();
    const start = Date.now();
    await Promise.all([
      svc.sendMessage('chat-1', 'a'),
      svc.sendMessage('chat-1', 'b'),
      svc.sendMessage('chat-1', 'c'),
    ]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(2 * 1100 - 50); // 3 sends => 2 inter-arrival gaps
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 10_000);

  it('retries once on HTTP 429 honoring retry_after', async () => {
    fetchMock
      .mockResolvedValueOnce(tooManyRequests(0)) // retry quickly to keep test fast
      .mockResolvedValueOnce(okResponse());
    const svc = makeService();
    const result = await svc.sendMessage('chat-2', 'hello');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.message_id).toBe(1);
  }, 10_000);

  it('cancels a 429 retry chain at the caller deadline', async () => {
    fetchMock.mockResolvedValue(tooManyRequests(60));
    const svc = makeService();

    await expect(svc.sendMessage('chat-deadline', 'hello', {
      deadlineAt: Date.now() + 50,
    })).rejects.toBeDefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('does not enqueue a Telegram call whose absolute deadline has passed', async () => {
    const svc = makeService();

    await expect(svc.sendMessage('chat-expired', 'hello', {
      deadlineAt: Date.now() - 1,
    })).rejects.toThrow('Telegram operation deadline exceeded');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns a Bottleneck job that reaches the front after its deadline into a no-op', async () => {
    let releaseFirst!: (response: Response) => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      releaseFirst = resolve;
      markFirstStarted();
    }));
    const svc = makeService();
    const first = svc.sendMessage('chat-queued', 'first');
    await firstStarted;

    const expiredWhileQueued = svc.sendMessage('chat-queued', 'second', {
      deadlineAt: Date.now() + 50,
    });
    await expect(expiredWhileQueued).rejects.toBeDefined();
    releaseFirst(okResponse());
    await first;

    // Let the per-chat 1.1s interval elapse so the canceled closure reaches the
    // front of the limiter and proves it does not issue a second HTTP request.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('throws TelegramApiError on non-429 4xx', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('{"description":"bot was blocked by the user"}'),
    } as unknown as Response);
    const svc = makeService();
    await expect(svc.sendMessage('chat-3', 'hello')).rejects.toBeInstanceOf(TelegramApiError);
  }, 10_000);

  it('treats an already-upgraded Telegram message as an idempotent edit', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"description":"Bad Request: message is not modified"}'),
    } as unknown as Response);
    const svc = makeService();

    await expect(svc.editMessageText('chat-4', 42, 'final receipt')).resolves.toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      chat_id: 'chat-4',
      message_id: 42,
      text: 'final receipt',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  });

  it('publishes launch-facing command menu entries', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const svc = makeService();

    await svc.setMyCommands();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.commands.map((cmd: { command: string }) => cmd.command)).toEqual([
      'connect',
      'reconnect',
      'privacy',
      'trust',
      'diagnostics',
      'groupstatus',
      'setup',
      'status',
      'sync',
      'inferred',
      'disconnect',
      'help',
    ]);
  });

  it('verifies bot identity and registers a serial webhook without dropping queued updates', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, result: { username: 'TradePing_Bot' } }),
      } as unknown as Response)
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(okResponse());
    const svc = makeService();

    await svc.onModuleInit();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.telegram.org/bottoken/getMe',
      'https://api.telegram.org/bottoken/setWebhook',
      'https://api.telegram.org/bottoken/setMyCommands',
    ]);
    const webhookBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(webhookBody).toEqual({
      url: 'https://tradeping.example/telegram/webhook',
      secret_token: 'secret',
      allowed_updates: ['message', 'my_chat_member'],
      max_connections: 1,
    });
    expect(webhookBody).not.toHaveProperty('drop_pending_updates');
  });

  it('does not register the webhook when getMe disagrees with the configured bot identity', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, result: { username: 'another_bot' } }),
    } as unknown as Response);

    await makeService().onModuleInit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.telegram.org/bottoken/getMe');
  });

  it('recognizes Telegram group administrators', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: { status: 'administrator' } }),
    } as unknown as Response);
    const svc = makeService();

    await expect(svc.isChatAdmin('-100', '123')).resolves.toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ chat_id: '-100', user_id: '123' });
  });

  it('keeps an admin command retryable when Telegram admin lookup is unavailable', async () => {
    fetchMock.mockRejectedValue(new Error('network unavailable'));
    await expect(makeService().isChatAdmin('-100', '123')).rejects.toThrow('network unavailable');
  });

  it('keeps an admin command retryable when Telegram rejects the lookup', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve('temporarily unavailable'),
    } as unknown as Response);
    await expect(makeService().isChatAdmin('-100', '123')).rejects.toBeInstanceOf(TelegramApiError);
  });

  it('recognizes Telegram anonymous group admins', async () => {
    await expect(makeService().isChatAdmin('-100', '1087968824')).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
