import { Bytes } from "@graphprotocol/graph-ts";
import {
  AssetRegistered,
  AssetUpdated,
  AssetSupportUpdated,
  PairSupportUpdated,
} from "../generated/AssetRegistry/AssetRegistry";
import { Asset, AssetPair } from "../generated/schema";
import { crypto, ByteArray } from "@graphprotocol/graph-ts";

export function handleAssetRegistered(event: AssetRegistered): void {
  let asset = new Asset(event.params.asset);
  asset.symbol = event.params.symbol;
  asset.feedKey = event.params.feedKey;
  asset.decimals = event.params.decimals;
  asset.isSupported = true;
  asset.save();
}

export function handleAssetUpdated(event: AssetUpdated): void {
  let asset = Asset.load(event.params.asset);
  if (!asset) {
    asset = new Asset(event.params.asset);
    asset.isSupported = true;
  }
  asset.symbol = event.params.symbol;
  asset.feedKey = event.params.feedKey;
  asset.decimals = event.params.decimals;
  asset.save();
}

export function handleAssetSupportUpdated(event: AssetSupportUpdated): void {
  let asset = Asset.load(event.params.asset);
  if (!asset) return;
  asset.isSupported = event.params.supported;
  asset.save();
}

export function handlePairSupportUpdated(event: PairSupportUpdated): void {
  let pairId = crypto.keccak256(
    event.params.collateral.concat(event.params.asset)
  );
  let pair = AssetPair.load(Bytes.fromByteArray(pairId));
  if (!pair) {
    pair = new AssetPair(Bytes.fromByteArray(pairId));
    pair.collateral = event.params.collateral;
    pair.asset = event.params.asset;
  }
  pair.isSupported = event.params.supported;
  pair.save();
}
