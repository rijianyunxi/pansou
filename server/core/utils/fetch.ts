/** Compatibility entry point; HTTP transport belongs to core/http. */
export {
  createNodePinnedHttpTransport,
  loadPinnedHttpTransport,
} from "../http/pinnedTransport";
export type {
  PinnedRequestInit,
  PinnedHttpTransport,
  NodeClientRequestLike,
  NodePinnedHttpModule,
  NodePinnedTransportModules,
} from "../http/pinnedTransport";
