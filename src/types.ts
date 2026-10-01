export type Channel = 'shopify' | 'amazon' | 'instore';

export interface Product {
  id: number;
  name: string;
  sku: string;
  central_quantity: number;
  shopify_quantity: number;
  amazon_quantity: number;
  instore_quantity: number;
  created_at: string;
  updated_at: string;
}

export const CHANNELS: Channel[] = ['shopify', 'amazon', 'instore'];

// Maps a channel name to its mirrored-quantity column in the DB.
export const CHANNEL_COLUMN: Record<Channel, string> = {
  shopify: 'shopify_quantity',
  amazon: 'amazon_quantity',
  instore: 'instore_quantity',
};
export interface InventorySyncRequest { sku: string; quantitySold: number; sourceChannel: Channel; } export interface InventoryHistoryEvent { id: number; productId: number; sku: string; channel: Channel; quantityDeducted: number; resultingCentralQuantity: number; createdAt: string; } export interface ChannelBroadcastResult { channel: Channel; broadcastQuantity: number; status: 'broadcasted'; } export interface InventorySyncResponse { success: true; product: Product; historyEvent: InventoryHistoryEvent; broadcasts: ChannelBroadcastResult[]; } export interface ApiErrorResponse { success: false; error: string; }