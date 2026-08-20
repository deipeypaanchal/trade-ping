export type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id: number;
    date?: number;
    text?: string;
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
    new_chat_members?: Array<{ id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }>;
    left_chat_member?: { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
    chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string };
  };
  my_chat_member?: {
    chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string };
    from: { id: number; first_name?: string; last_name?: string; username?: string };
    date: number;
    old_chat_member: { status: string };
    new_chat_member: { status: string };
  };
};
