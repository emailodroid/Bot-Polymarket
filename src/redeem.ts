import { ClobService } from "./clob.js";
import { Logger } from "./logger.js";
import { Position } from "./types.js";

export class RedeemService {
  constructor(
    private clob: ClobService,
    private logger: Logger,
  ) {}

  async redeemPositions(positions: Position[]): Promise<string[]> {
    const conditionIds = new Set<string>();
    for (const pos of positions) {
      if (pos.redeemable) conditionIds.add(pos.conditionId);
    }

    const txHashes: string[] = [];
    for (const conditionId of conditionIds) {
      try {
        const handle = await this.clob.sdk.redeemPositions({ conditionId });
        const outcome = await handle.wait();
        txHashes.push(outcome.transactionHash);
        this.logger.info("Redeem executed", {
          conditionId,
          txHash: outcome.transactionHash,
        });
      } catch (err) {
        this.logger.warn("Redeem transaction failed", {
          conditionId,
          error: (err as Error).message,
        });
      }
    }
    return txHashes;
  }
}
