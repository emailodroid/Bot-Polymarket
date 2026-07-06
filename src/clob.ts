import { createSecureClient, OrderSide } from "@polymarket/client";
import { privateKey } from "@polymarket/client/viem";
import { Wallet } from "ethers";
import { Logger } from "./logger.js";

export interface ApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export interface ClobConfig {
  privateKey: string;
  funderAddress?: string;
  apiCreds?: ApiCreds;
}

export interface MarketMeta {
  tickSize: number;
  minOrderSize: number;
  negRisk: boolean;
}

type PolymarketClient = Awaited<ReturnType<typeof createSecureClient>>;
type SecureClientOptions = Parameters<typeof createSecureClient>[0];

export class ClobService {
  private client: PolymarketClient;
  private logger: Logger;
  private metaCache: Map<string, { meta: MarketMeta; ts: number }> = new Map();

  private constructor(client: PolymarketClient, logger: Logger) {
    this.client = client;
    this.logger = logger;
  }

  static async init(config: ClobConfig, logger: Logger): Promise<ClobService> {
    const pk = config.privateKey.startsWith("0x")
      ? config.privateKey
      : `0x${config.privateKey}`;
    const signerAddress = new Wallet(pk).address;
    // Only force an explicit account wallet when a separate funder (proxy or
    // safe) is configured. Passing the signer's own EOA would opt into EOA
    // trading, which the CLOB rejects ("maker address not allowed"); omitting
    // the wallet lets the SDK resolve the account's Deposit Wallet instead.
    const funder = config.funderAddress;
    const wallet =
      funder && funder.toLowerCase() !== signerAddress.toLowerCase()
        ? funder
        : undefined;

    logger.info("Authenticating with Polymarket");
    const client = await createSecureClient({
      signer: privateKey(pk as `0x${string}`),
      wallet,
      credentials: config.apiCreds,
    } as SecureClientOptions);
    logger.info("Polymarket client ready", { ...client.account });
    return new ClobService(client, logger);
  }

  get accountWallet(): string {
    return this.client.account.wallet;
  }

  async getMarketMeta(tokenId: string): Promise<MarketMeta> {
    const cached = this.metaCache.get(tokenId);
    const now = Date.now();
    if (cached && now - cached.ts < 5 * 60 * 1000) return cached.meta;

    const ob = await this.client.fetchOrderBook({ tokenId });
    const meta: MarketMeta = {
      tickSize: Number(ob.tickSize),
      minOrderSize: Number(ob.minOrderSize),
      negRisk: Boolean(ob.negRisk),
    };
    this.metaCache.set(tokenId, { meta, ts: now });
    return meta;
  }

  private roundToTick(price: number, tick: number, side: OrderSide): number {
    if (!Number.isFinite(tick) || tick <= 0) return price;
    const factor = Math.round(1 / tick);
    const raw = price * factor;
    const rounded = side === OrderSide.BUY ? Math.floor(raw) : Math.ceil(raw);
    const result = rounded / factor;
    const decimals = Math.max(1, Math.ceil(Math.log10(factor)));
    return Number(result.toFixed(decimals));
  }

  async placeLimitOrder(params: {
    tokenId: string;
    side: OrderSide;
    price: number;
    size: number;
  }): Promise<void> {
    const { tokenId, side } = params;
    const meta = await this.getMarketMeta(tokenId);

    const price = this.roundToTick(params.price, meta.tickSize, side);
    const size = params.size;

    if (size < meta.minOrderSize) {
      this.logger.warn("Order size below minimum", {
        tokenId,
        size,
        min: meta.minOrderSize,
      });
      return;
    }

    const resp = await this.client.placeLimitOrder({
      tokenId,
      side,
      price,
      size,
    });
    if (!resp.ok) {
      throw new Error(`${resp.message} (${resp.code})`);
    }
  }
}
