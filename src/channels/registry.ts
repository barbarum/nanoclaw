import {
  Channel,
  OnInboundMessage as OnInboundMessageType,
  OnChatMetadata as OnChatMetadataType,
  RegisteredGroup,
} from '../types.js';

export type OnInboundMessage = OnInboundMessageType;
export type OnChatMetadata = OnChatMetadataType;

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
