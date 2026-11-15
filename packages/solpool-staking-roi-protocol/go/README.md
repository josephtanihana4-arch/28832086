# Unified Go Package (`solpool-staking-roi-protocol/go`)

100% On-Chain Go SDK implementation for the Solana Native Proof-of-Stake Protocol (`TitaniumStakingProtocol` / `SolanaStakingRoiProtocol`) with:
- **$150.00/hr Native PoS $ Rate in Real SOL**: Connects directly to live Solana Mainnet/Devnet JSON-RPC (`getSlot`, `getTransaction`, `getBlockTime`) and live SOL/USD price oracles (Coinbase/CoinGecko). Requires a confirmed on-chain Solana anchor transaction signature — **zero simulators and zero offline clocks**.
- **$150.00/hour ($3,600.00/day) Native PoS Yield** & **100% Personal Vault Price Protection**.

```go
client := pos.NewClient("https://api.mainnet-beta.solana.com")
rate, err := client.GetLive150UsdHourlySolRate()
earn, err := client.GetOnChainHourly150UsdEarn("<CONFIRMED_ANCHOR_SIGNATURE>")
```
