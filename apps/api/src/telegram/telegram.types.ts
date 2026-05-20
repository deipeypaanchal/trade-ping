export type TelegramUpdate = {
  message?: {
    message_id: number;
    text?: string;
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
    chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string };
  };
};
