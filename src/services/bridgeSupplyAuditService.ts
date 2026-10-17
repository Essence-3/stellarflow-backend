import { prisma } from "../lib/prisma.js";
import stellarProvider from "../lib/stellarProvider.js";
import {
  Contract,
  scValToBigInt,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { ethers } from "ethers";
import { logger } from "../utils/logger.js";
import { getStellarNetworkPassphrase } from "../lib/stellarNetwork.js";
import { signer } from "../signer.js";
import { generateKsuid } from "../utils/ksuid.js";
import { createTimeoutSignal } from "../utils/httpTimeout.js";
import { EventBusAlertDispatcher } from "./eventBus/alertDispatcher.js";
import {
  notificationService,
  AlertSeverity,
  AlertType,
} from "./notificationService.js";

export interface BridgeSupplyAuditComparison {
  bridgeChainId: string;
  chainName: string;
  chainType: string;
  sorobanContractId: string;
  remoteContractAddress: string;
  sorobanSupply: bigint;
  remoteCollateralBalance: bigint;
  delta: bigint;
  hasMismatch: boolean;
  timestamp: Date;
}

export interface BridgeSupplyAuditConfig {
  checkIntervalMs?: number; // Defaults to 15 minutes (900000ms)
  enabled?: boolean;
}

/**
 * BridgeSupplyAuditService
 * 
 * Verifies wrapped asset supply on Soroban perfectly matches locked backing assets on remote chains.
 * - Fetches total supply of wrapped tokens on Soroban via RPC every 15 minutes.
 * - Queries collateral vault balance on target EVM / Solana chains concurrently.
 * - Raises high-priority PagerDuty alarm if supply mismatch delta S != 0 is detected.
 */
export class BridgeSupplyAuditService {
  private isRunning: boolean = false;
  private isAuditing: boolean = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly checkIntervalMs: number;
  private readonly settlementGraceMs: number;
  private readonly enabled: boolean;
  private readonly alertDispatcher: EventBusAlertDispatcher;

  constructor(config?: BridgeSupplyAuditConfig) {
    const configuredInterval =
      config?.checkIntervalMs ??
      Number(process.env.BRIDGE_SUPPLY_AUDIT_INTERVAL_MS ?? "900000");
    this.checkIntervalMs =
      Number.isSafeInteger(configuredInterval) && configuredInterval > 0
        ? configuredInterval
        : 900000;
    const configuredGrace = Number(
      process.env.BRIDGE_SUPPLY_AUDIT_SETTLEMENT_GRACE_MS ?? "1800000",
    );
    this.settlementGraceMs =
      Number.isSafeInteger(configuredGrace) && configuredGrace >= 0
        ? configuredGrace
        : 1800000;
    this.enabled =
      config?.enabled ?? process.env.BRIDGE_SUPPLY_AUDIT_ENABLED !== "false";
    this.alertDispatcher = new EventBusAlertDispatcher({
      pagerdutyRoutingKey: process.env.PAGERDUTY_ROUTING_KEY,
      source: "stellarflow-bridge-supply-audit",
    });
  }

  public getStatus(): { isRunning: boolean; checkIntervalMs: number } {
    return {
      isRunning: this.isRunning,
      checkIntervalMs: this.checkIntervalMs,
    };
  }

  public start(): void {
    if (!this.enabled) {
      logger.info("[BridgeSupplyAuditService] Disabled by configuration");
      return;
    }
    if (this.isRunning) {
      logger.warn("[BridgeSupplyAuditService] Service is already running");
      return;
    }

    this.isRunning = true;
    logger.info(`[BridgeSupplyAuditService] Started with check interval ${this.checkIntervalMs}ms`);

    this.auditAllBridges().catch((err) => {
      logger.error("[BridgeSupplyAuditService] Initial audit pass failed:", err);
    });
    this.timer = setInterval(() => {
      this.auditAllBridges().catch((err) => {
        logger.error("[BridgeSupplyAuditService] Error during scheduled audit pass:", err);
      });
    }, this.checkIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    logger.info("[BridgeSupplyAuditService] Stopped");
  }

  /**
   * Compare Soroban wrapped supply against remote collateral balance for a specific bridge chain mapping.
   */
  public async evaluateBridgeSupply(params: {
    bridgeChainId: string;
    chainName: string;
    chainType: string;
    sorobanContractId: string;
    remoteContractAddress: string;
    sorobanSupply: bigint;
    remoteCollateralBalance: bigint;
  }): Promise<BridgeSupplyAuditComparison> {
    const delta = params.sorobanSupply - params.remoteCollateralBalance;
    const hasMismatch = delta !== 0n;

    return {
      bridgeChainId: params.bridgeChainId,
      chainName: params.chainName,
      chainType: params.chainType,
      sorobanContractId: params.sorobanContractId,
      remoteContractAddress: params.remoteContractAddress,
      sorobanSupply: params.sorobanSupply,
      remoteCollateralBalance: params.remoteCollateralBalance,
      delta,
      hasMismatch,
      timestamp: new Date(),
    };
  }

  /**
   * Fetch total supply of wrapped tokens on Soroban via RPC.
   */
  public async fetchSorobanTotalSupply(sorobanContractId: string): Promise<bigint> {
    try {
      const rpcServer = stellarProvider.getRpcServer();
      const horizonServer = stellarProvider.getServer();
      const sourceAccount = await horizonServer.loadAccount(
        await signer.getPublicKey(),
      );
      const transaction = new TransactionBuilder(sourceAccount, {
        fee: await horizonServer.fetchBaseFee(),
        networkPassphrase: getStellarNetworkPassphrase(),
      })
        .addOperation(new Contract(sorobanContractId).call("total_supply"))
        .setTimeout(30)
        .build();
      const simulation = await rpcServer.simulateTransaction(transaction);

      if (!("results" in simulation) || !simulation.results?.[0]?.xdr) {
        const reason = "error" in simulation ? simulation.error : "No return value";
        throw new Error(`Soroban total_supply simulation failed: ${String(reason)}`);
      }

      const returnValue = xdr.ScVal.fromXDR(
        simulation.results[0].xdr,
        "base64",
      );
      return scValToBigInt(returnValue);
    } catch (error) {
      logger.error(`[BridgeSupplyAuditService] Failed to fetch Soroban total supply for contract ${sorobanContractId}:`, error);
      throw error;
    }
  }

  /**
   * Query collateral vault balance on target EVM or Solana chains concurrently.
   */
  public async fetchRemoteCollateralBalance(chain: { chainType: string; rpcUrl?: string | null; bridgeContract?: string | null }): Promise<bigint> {
    if (!chain.bridgeContract || !chain.rpcUrl) {
      throw new Error("Missing RPC URL or bridge contract address for remote collateral query");
    }

    const chainType = chain.chainType.toUpperCase();
    if (chainType === "EVM") {
      const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
      const method = process.env.BRIDGE_COLLATERAL_METHOD?.trim() || "totalAssets";
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(method)) {
        throw new Error("Invalid BRIDGE_COLLATERAL_METHOD function name");
      }
      const abi = [`function ${method}() view returns (uint256)`];
      const contract = new ethers.Contract(chain.bridgeContract, abi, provider);
      const balance = await contract[method]();
      return BigInt(balance.toString());
    } else if (chainType === "SOLANA") {
      const response = await fetch(chain.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "bridge-supply-audit",
          method: "getTokenAccountBalance",
          params: [chain.bridgeContract, { commitment: "finalized" }],
        }),
        signal: createTimeoutSignal(10000),
      });
      if (!response.ok) {
        throw new Error(`Solana RPC returned HTTP ${response.status}`);
      }
      const payload = (await response.json()) as {
        error?: { message?: string };
        result?: { value?: { amount?: string } };
      };
      if (payload.error) {
        throw new Error(`Solana RPC error: ${payload.error.message ?? "unknown error"}`);
      }
      const amount = payload.result?.value?.amount;
      if (!amount || !/^\d+$/.test(amount)) {
        throw new Error("Solana RPC returned an invalid token account amount");
      }
      return BigInt(amount);
    } else {
      throw new Error(`Unsupported chain type for collateral query: ${chain.chainType}`);
    }
  }

  /**
   * Audit all configured bridge chains concurrently.
   */
  public async auditAllBridges(): Promise<BridgeSupplyAuditComparison[]> {
    if (this.isAuditing) {
      logger.warn("[BridgeSupplyAuditService] Skipping overlapping audit pass");
      return [];
    }

    this.isAuditing = true;
    try {
      const chains = await prisma.bridgeChain.findMany({
        where: { isActive: true },
      });
      const remoteChains = chains.filter(
        (chain) => chain.chainType.toUpperCase() !== "STELLAR",
      );

      if (remoteChains.length === 0) {
        return [];
      }

      const sorobanContractId = process.env.SOROBAN_BRIDGE_CONTRACT_ID?.trim();
      if (!sorobanContractId) {
        throw new Error("SOROBAN_BRIDGE_CONTRACT_ID is not configured");
      }

      const [sorobanSupply, chainBalances] = await Promise.all([
        this.fetchSorobanTotalSupply(sorobanContractId),
        Promise.all(
          remoteChains.map(async (chain) => ({
            chain,
            balance: await this.fetchRemoteCollateralBalance(chain),
          })),
        ),
      ]);
      const remoteCollateralBalance = chainBalances.reduce(
        (total, item) => total + item.balance,
        0n,
      );
      const comparison = await this.evaluateBridgeSupply({
        bridgeChainId: remoteChains.map((chain) => chain.chainId).join(","),
        chainName: "All active bridge chains",
        chainType: "aggregate",
        sorobanContractId,
        remoteContractAddress: chainBalances
          .map(({ chain }) => chain.bridgeContract ?? "")
          .join(","),
        sorobanSupply,
        remoteCollateralBalance,
      });

      let alertDeferredReason: string | null = null;
      if (comparison.hasMismatch) {
        try {
          const pendingEvent = await prisma.bridgeEvent.findFirst({
            where: {
              chainId: { in: remoteChains.map((chain) => chain.id) },
              status: { in: ["PENDING", "VERIFIED", "STAGED"] },
              createdAt: {
                gte: new Date(Date.now() - this.settlementGraceMs),
              },
            },
            select: { id: true, status: true },
          });
          if (pendingEvent) {
            alertDeferredReason = `Bridge event ${pendingEvent.id} is ${pendingEvent.status} within the settlement grace period`;
          }
        } catch (error) {
          alertDeferredReason = "Unable to verify pending bridge events";
          logger.error(
            "[BridgeSupplyAuditService] Could not check pending bridge events:",
            error,
          );
        }
      }

      let auditPersisted = true;
      try {
        await prisma.auditLog.create({
          data: {
            id: generateKsuid(),
            eventType: "BRIDGE_SUPPLY_RECONCILIATION",
            actionType: "SUPPLY_RECONCILIATION",
            actorPublicKey: "system:bridge-supply-audit",
            actorName: "Bridge Supply Audit Service",
            actorRole: "SYSTEM",
            eventDetails: JSON.stringify({
              bridgeChainId: comparison.bridgeChainId,
              chainName: comparison.chainName,
              sorobanContractId: comparison.sorobanContractId,
              sorobanSupply: comparison.sorobanSupply.toString(),
              remoteCollateralBalance:
                comparison.remoteCollateralBalance.toString(),
              chainBalances: chainBalances.map(({ chain, balance }) => ({
                chainId: chain.chainId,
                chainName: chain.chainName,
                chainType: chain.chainType,
                contractAddress: chain.bridgeContract,
                balance: balance.toString(),
              })),
              delta: comparison.delta.toString(),
              hasMismatch: comparison.hasMismatch,
              alertDeferredReason,
            }),
            newState: comparison.hasMismatch
              ? alertDeferredReason
                ? "MISMATCH_DEFERRED"
                : "MISMATCH"
              : "MATCH",
            occurredAt: comparison.timestamp,
          },
        });
      } catch (error) {
        auditPersisted = false;
        logger.error(
          "[BridgeSupplyAuditService] Failed to persist reconciliation record:",
          error,
        );
      }

      if (comparison.hasMismatch && !alertDeferredReason) {
        await this.handleSupplyMismatch(comparison);
      } else if (alertDeferredReason) {
        logger.warn(
          `[BridgeSupplyAuditService] Mismatch alarm deferred: ${alertDeferredReason}`,
        );
      }

      return auditPersisted ? [comparison] : [];
    } catch (error) {
      logger.error("[BridgeSupplyAuditService] Error during audit pass:", error);
      return [];
    } finally {
      this.isAuditing = false;
    }
  }

  /**
   * Raise high-priority PagerDuty alarm if supply mismatch delta != 0 is detected.
   */
  public async handleSupplyMismatch(
    comparison: BridgeSupplyAuditComparison,
  ): Promise<void> {
    logger.error(
      `[BridgeSupplyAuditService] 🚨 SUPPLY MISMATCH DETECTED on ${comparison.chainName} (${comparison.chainType})! Soroban Supply: ${comparison.sorobanSupply.toString()}, Remote Vault Balance: ${comparison.remoteCollateralBalance.toString()}, Delta: ${comparison.delta.toString()}`
    );

    try {
      await notificationService.sendAlert({
        type: AlertType.SUPPLY_INVARIANT_DRIFT,
        severity: AlertSeverity.CRITICAL,
        title: `Bridge Wrapped Token Supply Mismatch on ${comparison.chainName}`,
        message:
          `Wrapped token supply on Soroban (${comparison.sorobanSupply.toString()}) ` +
          `does not match collateral vault balance (${comparison.remoteCollateralBalance.toString()}). ` +
          `Delta: ${comparison.delta.toString()}.`,
        details: {
          bridgeChainId: comparison.bridgeChainId,
          chainName: comparison.chainName,
          chainType: comparison.chainType,
          sorobanContractId: comparison.sorobanContractId,
          remoteContractAddress: comparison.remoteContractAddress,
          sorobanSupply: comparison.sorobanSupply.toString(),
          remoteCollateralBalance: comparison.remoteCollateralBalance.toString(),
          delta: comparison.delta.toString(),
        },
        timestamp: comparison.timestamp,
        service: "BridgeSupplyAuditService",
      });
      await this.alertDispatcher.triggerIncident({
        summary: `CRITICAL: Bridge wrapped-token supply mismatch on ${comparison.chainName}. Delta: ${comparison.delta.toString()}`,
        dedupKey: "stellarflow-bridge-supply-reconciliation-aggregate",
        details: {
          bridgeChainId: comparison.bridgeChainId,
          chainName: comparison.chainName,
          chainType: comparison.chainType,
          sorobanContractId: comparison.sorobanContractId,
          remoteContractAddress: comparison.remoteContractAddress,
          sorobanSupply: comparison.sorobanSupply.toString(),
          remoteCollateralBalance: comparison.remoteCollateralBalance.toString(),
          delta: comparison.delta.toString(),
        },
      });
    } catch (notifErr) {
      logger.error("[BridgeSupplyAuditService] Failed to dispatch PagerDuty alert for supply mismatch:", notifErr);
    }
  }
}

let auditServiceInstance: BridgeSupplyAuditService | null = null;

export function getBridgeSupplyAuditService(): BridgeSupplyAuditService {
  if (!auditServiceInstance) {
    auditServiceInstance = new BridgeSupplyAuditService();
  }
  return auditServiceInstance;
}
