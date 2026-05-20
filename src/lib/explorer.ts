const EXPLORER_BASE = "https://lora.algokit.io/testnet";

export const explorerUrl = {
  tx: (txHash: string) => `${EXPLORER_BASE}/transaction/${txHash}`,
  account: (address: string) => `${EXPLORER_BASE}/account/${address}`,
  app: (appId: number | string) => `${EXPLORER_BASE}/application/${appId}`,
};
