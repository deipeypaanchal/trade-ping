export type SnapTradeUser = { userId: string; userSecret: string };
export type SnapTradePortal = { redirectURI: string; sessionId?: string };

export type SnapTradeConnection = {
  id: string;
  name?: string;
  type?: string;
  disabled?: boolean;
  disabled_date?: string | null;
  brokerage?: { slug?: string; name?: string; display_name?: string };
};

export type SnapTradeAccount = {
  id: string;
  name?: string;
  number?: string;
  institution_name?: string;
  meta?: Record<string, unknown>;
  raw_type?: string;
  brokerage_authorization?: string | { id?: string };
};

export type SnapTradeOrder = {
  brokerage_order_id?: string;
  id?: string;
  status?: string;
  action?: string;
  side?: string;
  type?: string;
  order_type?: string;
  time_in_force?: string;
  symbol?: string;
  universal_symbol?: { symbol?: string; raw_symbol?: string } | null;
  option_symbol?: { ticker?: string; symbol?: string } | null;
  total_quantity?: number | string;
  filled_quantity?: number | string;
  quantity?: number | string;
  price?: number | string;
  average_fill_price?: number | string;
  execution_price?: number | string;
  created_date?: string;
  updated_date?: string;
  filled_date?: string;
  execution_time?: string;
  trade_date?: string;
  time_executed?: string;
  time_placed?: string;
  time_updated?: string;
};

export type SnapTradeRecentOrders = {
  orders?: SnapTradeOrder[];
};

export type SnapTradePosition = {
  symbol?: {
    id?: string;
    symbol?: string | { id?: string; symbol?: string; raw_symbol?: string; description?: string };
    raw_symbol?: string;
    description?: string;
    currency?: { code?: string };
  } | null;
  universal_symbol?: { id?: string; symbol?: string; raw_symbol?: string } | null;
  units?: number | string;
  quantity?: number | string;
  fractional_units?: number | string;
  price?: number | string;
  average_purchase_price?: number | string;
  currency?: string | { code?: string };
};
