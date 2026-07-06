import "dotenv/config";
import { webcrypto } from "crypto";
import { loadConfig, ConfigError, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { ClobService } from "./clob.js";
import { DataApiClient } from "./dataApi.js";
import { CopyTrader } from "./copyTrader.js";
import { RedeemService } from "./redeem.js";
import {
  loadState,
  markRedeemAttempt,
  pruneSeenTrades,
  saveState,
} from "./state.js";
import { nowSec, sleep } from "./utils.js";

const REDEEM_COOLDOWN_SEC = 600;
const IDLE_SLEEP_MS = 60000;

const idleLoop = async (): Promise<never> => {
  while (true) {
    console.log(`Fix configuration and restart the bot...`);
    await sleep(IDLE_SLEEP_MS);
  }
};

const main = async () => {
  if (!globalThis.crypto) {
    (globalThis as typeof globalThis & { crypto?: Crypto }).crypto =
      webcrypto as Crypto;
  }
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[config] ${err.message}`);
      await idleLoop();
    }
    throw err;
  }
  const logger = createLogger(config.debug);
  const state = await loadState(config.stateFile);

  const clob = await ClobService.init(
    {
      privateKey: config.privateKey,
      funderAddress: config.funderAddress,
      apiCreds: config.apiCreds,
    },
    logger,
  );

  if (clob.accountWallet.toLowerCase() !== config.profileAddress) {
    logger.warn(
      "PROFILE_ADDRESS differs from the trading wallet; position and redeem lookups may miss your positions",
      { profileAddress: config.profileAddress, tradingWallet: clob.accountWallet },
    );
  }

  const dataApi = new DataApiClient(config.dataApiHost, logger);
  const copyTrader = new CopyTrader(config, clob, dataApi, state, logger);

  const redeemService = config.autoRedeem
    ? new RedeemService(clob, logger)
    : null;

  const copyLoop = async () => {
    let lastHeartbeat = 0;
    while (true) {
      try {
        const now = Date.now();
        if (now - lastHeartbeat >= 30000) {
          logger.info("Polling traders...");
          lastHeartbeat = now;
        }
        await copyTrader.runOnce();
        pruneSeenTrades(state, config.maxSeenTradesAgeSec);
        await saveState(config.stateFile, state);
      } catch (err) {
        logger.error("Copy loop error", { error: (err as Error).message });
      }
      await sleep(config.pollIntervalMs);
    }
  };

  const redeemLoop = async () => {
    if (!redeemService) return;
    while (true) {
      try {
        const positions = await dataApi.getPositions(
          config.profileAddress,
          true,
        );
        const now = nowSec();
        const eligible = positions.filter((pos) => {
          const last = state.redeemAttempts[pos.conditionId] ?? 0;
          return now - last > REDEEM_COOLDOWN_SEC;
        });

        if (eligible.length) {
          await redeemService.redeemPositions(eligible);
          const attemptedConditions = new Set(
            eligible.map((p) => p.conditionId),
          );
          for (const conditionId of attemptedConditions) {
            markRedeemAttempt(state, conditionId);
          }
          await saveState(config.stateFile, state);
        }
      } catch (err) {
        logger.error("Redeem loop error", { error: (err as Error).message });
      }
      await sleep(config.redeemPollIntervalMs);
    }
  };

  await Promise.all([copyLoop(), redeemLoop()]);
};

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`[config] ${err.message}`);
    void idleLoop();
    return;
  }
  console.error(err);
  process.exit(1);
});
