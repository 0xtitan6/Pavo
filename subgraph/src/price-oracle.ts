import { Bytes } from "@graphprotocol/graph-ts";
import {
  FeedUpdated,
  SequencerFeedUpdated,
  MaxDeviationUpdated,
} from "../generated/PriceOracle/PriceOracle";
import { PriceFeed, ProtocolConfigChange } from "../generated/schema";

function eventId(txHash: Bytes, logIndex: i32): Bytes {
  return txHash.concatI32(logIndex);
}

export function handleFeedUpdated(event: FeedUpdated): void {
  let feed = new PriceFeed(event.params.token);
  feed.token = event.params.token;
  feed.feed = event.params.feed;
  feed.maxStaleness = event.params.maxStaleness;
  feed.feedDecimals = event.params.decimals;
  feed.save();
}

export function handleSequencerFeedUpdated(
  event: SequencerFeedUpdated
): void {
  let change = new ProtocolConfigChange(
    eventId(event.transaction.hash, event.logIndex.toI32())
  );
  change.type = "SequencerFeedUpdated";
  change.timestamp = event.block.timestamp;
  change.blockNumber = event.block.number;
  change.txHash = event.transaction.hash;
  change.newAddress = event.params.feed;
  change.save();
}

export function handleMaxDeviationUpdated(
  event: MaxDeviationUpdated
): void {
  let change = new ProtocolConfigChange(
    eventId(event.transaction.hash, event.logIndex.toI32())
  );
  change.type = "MaxDeviationUpdated";
  change.timestamp = event.block.timestamp;
  change.blockNumber = event.block.number;
  change.txHash = event.transaction.hash;
  change.oldValue = event.params.oldDeviation;
  change.newValue = event.params.newDeviation;
  change.save();
}
