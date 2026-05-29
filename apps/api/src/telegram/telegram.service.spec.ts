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

const chatMemberResponse = (status: string) =>
  ({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ result: { status } })),
  } as unknown as Response);

const tooManyRequests = (retryAfter = 1) =>
  ({
    ok: false,
    status: 429,
    text: () => Promise.resolve(JSON.stringify({ parameters: { retry_after: retryAfter } })),
  } as unknown as Response);

function makeService() {
  const config = new ConfigService({ TELEGRAM_BOT_TOKEN: 'token', APP_BASE_URL: 'https://tradeping.example', TELEGRAM_WEBHOOK_SECRET: 'secret' });
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

  it('throws TelegramApiError on non-429 4xx', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('{"description":"bot was blocked by the user"}'),
    } as unknown as Response);
    const svc = makeService();
    await expect(svc.sendMessage('chat-3', 'hello')).rejects.toBeInstanceOf(TelegramApiError);
  }, 10_000);

  it('checks group admin status through the rate-limited Telegram path', async () => {
    fetchMock.mockResolvedValue(chatMemberResponse('administrator'));
    const svc = makeService();

    await expect(svc.isChatAdmin('chat-4', 'user-1')).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/getChatMember');
  }, 10_000);

  it('retries getChatMember on HTTP 429', async () => {
    fetchMock
      .mockResolvedValueOnce(tooManyRequests(0))
      .mockResolvedValueOnce(chatMemberResponse('creator'));
    const svc = makeService();

    await expect(svc.isChatAdmin('chat-5', 'user-1')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('wraps malformed getChatMember JSON in TelegramApiError', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('not json'),
    } as unknown as Response);
    const svc = makeService();

    await expect(svc.isChatAdmin('chat-6', 'user-1')).rejects.toBeInstanceOf(TelegramApiError);
  }, 10_000);

  it('publishes launch-facing command menu entries', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const svc = makeService();

    await svc.setMyCommands();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.commands.map((cmd: { command: string }) => cmd.command)).toEqual([
      'connect',
      'privacy',
      'trust',
      'diagnostics',
      'groupstatus',
      'inferred',
      'setup',
      'status',
      'sync',
      'disconnect',
      'help',
    ]);
  });
});
